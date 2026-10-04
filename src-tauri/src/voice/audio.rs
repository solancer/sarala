//! Microphone capture: the default (or chosen) input device, downmixed to mono
//! and resampled to the 16 kHz the speech models expect.
//!
//! The design follows Handy's recorder (github.com/cjpais/Handy, MIT):
//!
//! - cpal calls the data callback on a real-time audio thread. Anything that
//!   can block there (a lock, an allocation, a log line) causes dropouts, so
//!   the callback only pushes samples into a wait-free single-producer,
//!   single-consumer ring buffer (`rtrb`).
//! - A worker thread owns the cpal `Stream` (it is not `Send` on every
//!   platform, so it must be created and dropped on one thread), drains the
//!   ring every 10 ms, and does the downmixing, resampling and level metering.
//! - The worker is driven by a command channel; `stop` flushes what is left
//!   and waits for the worker to finish, so no trailing words are lost.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, SizedSample};
use rubato::{FftFixedIn, Resampler};

pub const RATE: u32 = 16_000;
/// Chunks handed to the engine: 100 ms.
const CHUNK: usize = (RATE / 10) as usize;
const POLL: Duration = Duration::from_millis(10);
/// About 30 level updates a second is smooth enough for a meter.
const LEVEL_EVERY: Duration = Duration::from_millis(33);
const RESAMPLE_CHUNK: usize = 1024;

pub type Sink = Box<dyn FnMut(Vec<f32>) + Send>;
pub type LevelSink = Box<dyn FnMut(f32) + Send>;

enum Cmd {
    /// Flush and finish; reply when every sample has gone to the sink.
    Stop(mpsc::Sender<()>),
    Cancel,
}

pub struct Recording {
    cmd: mpsc::Sender<Cmd>,
    handle: Option<JoinHandle<()>>,
}

impl Recording {
    /// Stop capturing and wait until the remaining audio reached the sink.
    pub fn stop(mut self) {
        let (tx, rx) = mpsc::channel();
        if self.cmd.send(Cmd::Stop(tx)).is_ok() {
            let _ = rx.recv_timeout(Duration::from_secs(2));
        }
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }

    /// Stop capturing and drop whatever was not sent yet.
    pub fn cancel(mut self) {
        let _ = self.cmd.send(Cmd::Cancel);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
    }
}

impl Drop for Recording {
    fn drop(&mut self) {
        let _ = self.cmd.send(Cmd::Cancel);
    }
}

/// Names of the input devices, default first.
pub fn input_devices() -> Vec<String> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());
    let mut names: Vec<String> = host
        .input_devices()
        .map(|it| it.filter_map(|d| d.name().ok()).collect())
        .unwrap_or_default();
    names.dedup();
    if let Some(d) = default {
        names.retain(|n| *n != d);
        names.insert(0, d);
    }
    names
}

fn pick_device(name: Option<&str>) -> Result<cpal::Device, String> {
    let host = cpal::default_host();
    if let Some(want) = name.filter(|n| !n.is_empty()) {
        if let Ok(mut it) = host.input_devices() {
            if let Some(d) = it.find(|d| d.name().map(|n| n == want).unwrap_or(false)) {
                return Ok(d);
            }
        }
        // The chosen device was unplugged: fall back to the default.
    }
    host.default_input_device()
        .ok_or_else(|| "No microphone found.".to_string())
}

/// Open the microphone and start sending 16 kHz mono chunks to `sink`.
/// Returns once the stream is running (or failed to open).
pub fn start(device: Option<String>, sink: Sink, level: LevelSink) -> Result<Recording, String> {
    let (cmd_tx, cmd_rx) = mpsc::channel();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
    let handle = thread::Builder::new()
        .name("voice-capture".into())
        .spawn(move || worker(device, sink, level, cmd_rx, ready_tx))
        .map_err(|e| format!("Could not start audio thread: {e}"))?;
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => Ok(Recording {
            cmd: cmd_tx,
            handle: Some(handle),
        }),
        Ok(Err(e)) => {
            let _ = handle.join();
            Err(e)
        }
        Err(_) => Err("The microphone did not respond.".into()),
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut producer: rtrb::Producer<f32>,
    failed: Arc<AtomicBool>,
) -> Result<cpal::Stream, cpal::BuildStreamError>
where
    T: SizedSample,
    f32: cpal::FromSample<T>,
{
    device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            // Real-time thread: no locks, no allocation, no logging. If the
            // worker falls more than two seconds behind, samples are dropped.
            for &s in data {
                let _ = producer.push(<f32 as cpal::FromSample<T>>::from_sample_(s));
            }
        },
        move |_| failed.store(true, Ordering::Relaxed),
        None,
    )
}

fn worker(
    device: Option<String>,
    mut sink: Sink,
    mut level: LevelSink,
    cmd: mpsc::Receiver<Cmd>,
    ready: mpsc::Sender<Result<(), String>>,
) {
    let opened = (|| -> Result<_, String> {
        let device = pick_device(device.as_deref())?;
        let supported = device
            .default_input_config()
            .map_err(|e| format!("Could not read the microphone's format: {e}"))?;
        let format = supported.sample_format();
        let config: cpal::StreamConfig = supported.into();
        let channels = config.channels.max(1) as usize;
        let rate = config.sample_rate.0;
        let (producer, consumer) = rtrb::RingBuffer::<f32>::new(rate as usize * channels * 2);
        let failed = Arc::new(AtomicBool::new(false));
        let stream = match format {
            SampleFormat::F32 => build_stream::<f32>(&device, &config, producer, failed.clone()),
            SampleFormat::I16 => build_stream::<i16>(&device, &config, producer, failed.clone()),
            SampleFormat::U16 => build_stream::<u16>(&device, &config, producer, failed.clone()),
            SampleFormat::I32 => build_stream::<i32>(&device, &config, producer, failed.clone()),
            SampleFormat::U8 => build_stream::<u8>(&device, &config, producer, failed.clone()),
            other => return Err(format!("Unsupported microphone format {other:?}.")),
        }
        .map_err(|e| format!("Could not open the microphone: {e}"))?;
        stream
            .play()
            .map_err(|e| format!("Could not start the microphone: {e}"))?;
        Ok((stream, consumer, channels, rate, failed))
    })();
    let (stream, mut consumer, channels, rate, failed) = match opened {
        Ok(v) => {
            let _ = ready.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = ready.send(Err(e));
            return;
        }
    };

    let mut conv = Converter::new(rate, channels);
    let mut out: Vec<f32> = Vec::with_capacity(CHUNK * 2);
    let mut meter = Meter::default();
    let mut raw: Vec<f32> = Vec::with_capacity(rate as usize);

    let mut drain = |consumer: &mut rtrb::Consumer<f32>, out: &mut Vec<f32>, meter: &mut Meter| {
        raw.clear();
        let n = consumer.slots();
        if n == 0 {
            return;
        }
        if let Ok(chunk) = consumer.read_chunk(n) {
            let (a, b) = chunk.as_slices();
            raw.extend_from_slice(a);
            raw.extend_from_slice(b);
            chunk.commit_all();
        }
        let mono = conv.push(&raw, out);
        meter.add(mono);
    };

    let finish = loop {
        match cmd.recv_timeout(POLL) {
            Ok(Cmd::Stop(reply)) => break Some(reply),
            Ok(Cmd::Cancel) | Err(mpsc::RecvTimeoutError::Disconnected) => break None,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
        drain(&mut consumer, &mut out, &mut meter);
        while out.len() >= CHUNK {
            sink(out.drain(..CHUNK).collect());
        }
        if let Some(l) = meter.take_if_due() {
            level(l);
        }
        if failed.load(Ordering::Relaxed) {
            // Device unplugged or the OS revoked access: send what we have.
            break None;
        }
    };

    drop(stream);
    if let Some(reply) = finish {
        drain(&mut consumer, &mut out, &mut meter);
        conv.flush(&mut out);
        if !out.is_empty() {
            sink(std::mem::take(&mut out));
        }
        let _ = reply.send(());
    }
    level(0.0);
}

/// Interleaved device audio to 16 kHz mono.
struct Converter {
    channels: usize,
    resampler: Option<FftFixedIn<f32>>,
    pending: Vec<f32>,
    mono: Vec<f32>,
}

impl Converter {
    fn new(rate: u32, channels: usize) -> Self {
        let resampler = (rate != RATE)
            .then(|| {
                FftFixedIn::<f32>::new(rate as usize, RATE as usize, RESAMPLE_CHUNK, 2, 1).ok()
            })
            .flatten();
        Converter {
            channels,
            resampler,
            pending: Vec::new(),
            mono: Vec::new(),
        }
    }

    /// Append converted audio to `out`; returns this batch's mono samples
    /// (before resampling) for metering.
    fn push(&mut self, interleaved: &[f32], out: &mut Vec<f32>) -> &[f32] {
        let from = out.len();
        self.convert(interleaved, out);
        sanitize(&mut out[from..]);
        &self.mono
    }

    fn convert(&mut self, interleaved: &[f32], out: &mut Vec<f32>) {
        self.mono.clear();
        let ch = self.channels;
        self.mono.extend(
            interleaved
                .chunks(ch)
                .map(|f| f.iter().sum::<f32>() / ch as f32),
        );
        // Before the resampler, which can't take NaN or infinity.
        sanitize(&mut self.mono);
        match self.resampler.as_mut() {
            None => out.extend_from_slice(&self.mono),
            Some(r) => {
                self.pending.extend_from_slice(&self.mono);
                loop {
                    let need = r.input_frames_next();
                    if self.pending.len() < need {
                        break;
                    }
                    if let Ok(res) = r.process(&[&self.pending[..need]], None) {
                        out.extend_from_slice(&res[0]);
                    }
                    self.pending.drain(..need);
                }
            }
        }
    }

    fn flush(&mut self, out: &mut Vec<f32>) {
        if let Some(r) = self.resampler.as_mut() {
            if !self.pending.is_empty() {
                if let Ok(res) = r.process_partial(Some(&[&self.pending[..]]), None) {
                    let from = out.len();
                    out.extend_from_slice(&res[0]);
                    sanitize(&mut out[from..]);
                }
                self.pending.clear();
            }
        }
    }
}

/// Speech models and the voice detector expect samples in [-1, 1]; a hot
/// microphone or the resampler's ringing can go slightly past full scale.
fn sanitize(samples: &mut [f32]) {
    for x in samples {
        *x = if x.is_finite() { x.clamp(-1.0, 1.0) } else { 0.0 };
    }
}

/// Peak-holding RMS meter mapped to 0..1 (-60 dBFS .. 0 dBFS).
#[derive(Default)]
struct Meter {
    sum: f64,
    n: usize,
    last: Option<Instant>,
}

impl Meter {
    fn add(&mut self, s: &[f32]) {
        self.sum += s.iter().map(|x| (*x as f64) * (*x as f64)).sum::<f64>();
        self.n += s.len();
    }

    fn take_if_due(&mut self) -> Option<f32> {
        let now = Instant::now();
        if self.last.is_some_and(|t| now - t < LEVEL_EVERY) || self.n == 0 {
            return None;
        }
        self.last = Some(now);
        let rms = (self.sum / self.n as f64).sqrt();
        self.sum = 0.0;
        self.n = 0;
        Some(level_of(rms))
    }
}

pub fn level_of(rms: f64) -> f32 {
    if rms <= 1e-6 {
        return 0.0;
    }
    (((20.0 * rms.log10()) + 60.0) / 60.0).clamp(0.0, 1.0) as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converter_downmixes_and_resamples_to_16k() {
        // One second of a 440 Hz tone, stereo at 48 kHz.
        let rate = 48_000;
        let tone: Vec<f32> = (0..rate)
            .flat_map(|i| {
                let v = (i as f32 * 440.0 * std::f32::consts::TAU / rate as f32).sin() * 0.5;
                [v, v]
            })
            .collect();
        let mut c = Converter::new(rate, 2);
        let mut out = Vec::new();
        // In uneven pieces, like the ring buffer delivers them.
        for piece in tone.chunks(3_002) {
            c.push(piece, &mut out);
        }
        c.flush(&mut out);
        let expected = RATE as usize;
        assert!(
            out.len().abs_diff(expected) < 1_200,
            "got {} samples for one second",
            out.len()
        );
        let peak = out.iter().fold(0f32, |m, x| m.max(x.abs()));
        assert!((0.4..0.6).contains(&peak), "amplitude kept: {peak}");
    }

    #[test]
    fn converter_keeps_samples_in_range() {
        let mut c = Converter::new(48_000, 1);
        let mut out = Vec::new();
        // A clipped square wave makes the resampler ring past full scale.
        let square: Vec<f32> = (0..48_000).map(|i| if (i / 40) % 2 == 0 { 1.0 } else { -1.0 }).collect();
        c.push(&square, &mut out);
        c.push(&[f32::NAN; 4_800], &mut out);
        c.flush(&mut out);
        assert!(out.iter().all(|x| x.is_finite() && (-1.0..=1.0).contains(x)));
    }

    #[test]
    fn converter_passes_16k_mono_through() {
        let mut c = Converter::new(RATE, 1);
        let mut out = Vec::new();
        c.push(&[0.1, 0.2, 0.3], &mut out);
        assert_eq!(out, vec![0.1, 0.2, 0.3]);
    }

    #[test]
    fn level_maps_decibels() {
        assert_eq!(level_of(0.0), 0.0);
        assert!((level_of(1.0) - 1.0).abs() < 1e-6);
        assert!((level_of(0.001) - 0.0).abs() < 1e-6); // -60 dBFS
        assert!((level_of(0.0316) - 0.5).abs() < 0.01); // -30 dBFS
    }
}
