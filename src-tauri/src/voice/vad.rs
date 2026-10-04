//! Voice activity detection with Earshot (pure Rust, no ONNX runtime).
//!
//! Earshot scores 16 ms frames (256 samples at 16 kHz). The tracker remembers
//! where speech started and ended so a clip can be cut to the speech before it
//! is transcribed: whisper-family models tend to invent text ("Thank you.")
//! for long silences, and shorter input is faster.

use super::audio::RATE;

const FRAME: usize = 256;
const THRESHOLD: f32 = 0.5;
/// About 80 ms of speech frames before we believe someone spoke.
const MIN_SPEECH_FRAMES: usize = 5;
const PAD_BEFORE: usize = RATE as usize * 3 / 10;
const PAD_AFTER: usize = RATE as usize * 6 / 10;
/// Speech's loudness varies with syllables; steady noise's doesn't.
const MIN_MODULATION: f32 = 0.15;
/// Gaps between words shorter than this still count as speaking.
const HANGOVER: usize = RATE as usize * 45 / 100;

pub struct SpeechTracker {
    detector: Box<earshot::Detector>,
    carry: Vec<f32>,
    /// Samples consumed so far (whole frames).
    pos: usize,
    first: Option<usize>,
    last: usize,
    speech_frames: usize,
    speaking: bool,
    /// Consecutive speech frames now, and the longest such run so far.
    run: usize,
    longest_run: usize,
    /// Loudness of every frame, to tell speech (which rises and falls with
    /// syllables) from steady noise.
    levels: Vec<f32>,
    /// The frame handed to Earshot, clamped to [-1, 1]: microphones and
    /// resampling can overshoot slightly, and Earshot asserts on its range.
    frame: [f32; FRAME],
}

impl SpeechTracker {
    pub fn new() -> Self {
        SpeechTracker {
            detector: earshot::Detector::default_boxed(),
            carry: Vec::with_capacity(FRAME * 2),
            pos: 0,
            first: None,
            last: 0,
            speech_frames: 0,
            speaking: false,
            run: 0,
            longest_run: 0,
            levels: Vec::new(),
            frame: [0.0; FRAME],
        }
    }

    /// Score new audio. Returns the new state when the speaker started or
    /// stopped talking (for the "type at each pause" mode and the UI).
    pub fn push(&mut self, pcm: &[f32]) -> Option<bool> {
        self.carry.extend_from_slice(pcm);
        let whole = self.carry.len() / FRAME * FRAME;
        for chunk in self.carry[..whole].chunks_exact(FRAME) {
            for (d, s) in self.frame.iter_mut().zip(chunk) {
                *d = if s.is_finite() { s.clamp(-1.0, 1.0) } else { 0.0 };
            }
            let score = self.detector.predict_f32(&self.frame);
            self.levels.push((self.frame.iter().map(|x| x * x).sum::<f32>() / FRAME as f32).sqrt());
            if score >= THRESHOLD {
                self.first.get_or_insert(self.pos);
                self.last = self.pos + FRAME;
                self.speech_frames += 1;
                self.run += 1;
                self.longest_run = self.longest_run.max(self.run);
            } else {
                self.run = 0;
            }
            self.pos += FRAME;
        }
        self.carry.drain(..whole);
        let now = self.heard() && self.pos.saturating_sub(self.last) < HANGOVER;
        (now != self.speaking).then(|| {
            self.speaking = now;
            now
        })
    }

    /// How much loudness varies over the speech (coefficient of variation of
    /// frame RMS from first to last speech frame).
    pub fn modulation(&self) -> f32 {
        let Some(first) = self.first else { return 0.0 };
        let (a, b) = (first / FRAME, (self.last / FRAME).min(self.levels.len()));
        let v = &self.levels[a..b];
        if v.len() < 2 {
            return 0.0;
        }
        let mean = v.iter().sum::<f32>() / v.len() as f32;
        if mean <= 1e-6 {
            return 0.0;
        }
        let var = v.iter().map(|x| (x - mean).powi(2)).sum::<f32>() / v.len() as f32;
        var.sqrt() / mean
    }

    /// Did anyone speak? Enough speech frames, and loudness that rises and
    /// falls like syllables: a burst of steady noise can fool the detector for
    /// a few hundred milliseconds, and Whisper then invents text (it typed
    /// Korean for white noise in the benchmark). Measured on the benchmark
    /// clips, steady noise varies by 0.03 and every speech clip, including
    /// speech in noise and clipped loud speech, by 0.46 or more.
    pub fn heard(&self) -> bool {
        self.speech_frames >= MIN_SPEECH_FRAMES && self.modulation() >= MIN_MODULATION
    }

    /// The part of a clip of `len` samples worth transcribing.
    pub fn speech_bounds(&self, len: usize) -> (usize, usize) {
        match self.first {
            None => (0, len),
            Some(first) => {
                let a = first.saturating_sub(PAD_BEFORE);
                let b = (self.last + PAD_AFTER).min(len);
                if a < b {
                    (a, b)
                } else {
                    (0, len)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn silence_is_not_speech() {
        let mut t = SpeechTracker::new();
        for _ in 0..50 {
            t.push(&vec![0.0; 1600]);
        }
        assert!(!t.heard());
        assert_eq!(t.speech_bounds(80_000), (0, 80_000));
    }

    #[test]
    fn out_of_range_and_nan_samples_are_tolerated() {
        // A real microphone after resampling: slightly over full scale, and
        // the odd non-finite value. Earshot panics (in debug) on these.
        let mut t = SpeechTracker::new();
        let loud: Vec<f32> = (0..16_000).map(|i| if i % 7 == 0 { 1.3 } else if i % 11 == 0 { f32::NAN } else { -1.2 }).collect();
        t.push(&loud);
        t.push(&[f32::INFINITY; 300]);
    }

    /// Prints speech-frame statistics for the benchmark clips (diagnostics).
    #[test]
    #[ignore]
    fn vad_stats() {
        let dir = std::path::PathBuf::from(std::env::var("VOICE_BENCH_DIR").unwrap());
        let ids: Vec<String> = std::fs::read_dir(&dir).unwrap().filter_map(|e| e.ok()?.file_name().into_string().ok()).filter(|n| n.ends_with(".wav")).map(|n| n.trim_end_matches(".wav").to_string()).collect();
        for id in ids {
            let wav = std::fs::read(dir.join(format!("{id}.wav"))).unwrap();
            let pcm: Vec<f32> = wav[44..].chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
            let mut t = SpeechTracker::new();
            t.push(&pcm);
            println!("VAD {id:18} frames={:4} longest_run={:4} modulation={:.3} heard={}", t.speech_frames, t.longest_run, t.modulation(), t.heard());
        }
    }

    #[test]
    fn steady_noise_is_not_speech() {
        // White noise, even if the detector flags part of it, is steady.
        let mut seed = 7u32;
        let noise: Vec<f32> = (0..48_000)
            .map(|_| {
                seed = seed.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                ((seed >> 8) as f32 / 8_388_608.0 - 1.0) * 0.05
            })
            .collect();
        let mut t = SpeechTracker::new();
        t.push(&noise);
        assert!(!t.heard(), "modulation {}", t.modulation());
    }

    #[test]
    fn silence_never_reports_speaking() {
        let mut t = SpeechTracker::new();
        for _ in 0..20 {
            assert_eq!(t.push(&vec![0.0; 1600]), None);
        }
    }

    #[test]
    fn frames_are_scored_across_uneven_chunks() {
        let mut t = SpeechTracker::new();
        t.push(&vec![0.0; 300]);
        t.push(&vec![0.0; 300]);
        assert_eq!(t.pos, 512);
        assert_eq!(t.carry.len(), 88);
    }
}
