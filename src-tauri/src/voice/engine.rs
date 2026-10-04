//! The speech engine thread.
//!
//! One long-lived thread owns the loaded model (`transcribe_cpp::Model`) and
//! its `Session`. A session is `Send` but not `Sync` (it must not be used from
//! two threads at once), so rather than wrapping it in a mutex every caller
//! talks to this thread through a command channel. That also gives a natural
//! order: audio chunks that arrive while the model is still loading wait in the
//! channel and are transcribed once it is ready, so the user can start talking
//! straight away.
//!
//! Streaming models (Parakeet) are fed as audio arrives and report committed
//! text (final) plus tentative text (may still change). Other models collect
//! the audio, show a preview now and then, and transcribe the whole clip, cut
//! to the speech, when the user stops.

use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use transcribe_cpp::{Model, RunOptions, Session, StreamOptions};

use super::audio::RATE;
use super::vad::SpeechTracker;
use super::VoiceEvent;

pub type Emit = Arc<dyn Fn(VoiceEvent) + Send + Sync>;

pub enum Cmd {
    Load {
        id: String,
        path: PathBuf,
    },
    Unload,
    /// Start a dictation; Feed chunks follow, then Finish or Cancel.
    Begin {
        language: Option<String>,
    },
    Feed(Vec<f32>),
    /// Type what was said so far and keep listening ("type at each pause").
    Commit(mpsc::Sender<Result<String, String>>),
    Finish(mpsc::Sender<Result<String, String>>),
    Cancel,
    /// Unload after this long without use (None: keep loaded).
    SetIdle(Option<Duration>),
}

pub struct Engine {
    tx: mpsc::Sender<Cmd>,
    alive: Arc<AtomicBool>,
}

/// Clears `alive` when the engine thread ends, however it ends.
struct AliveGuard(Arc<AtomicBool>);
impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Relaxed);
    }
}

impl Engine {
    pub fn spawn(emit: Emit) -> Result<Engine, String> {
        let (tx, rx) = mpsc::channel();
        let alive = Arc::new(AtomicBool::new(true));
        let guard = AliveGuard(alive.clone());
        thread::Builder::new()
            .name("voice-engine".into())
            .spawn(move || {
                let _guard = guard;
                Worker::new(emit).run(rx)
            })
            .map_err(|e| format!("Could not start the speech engine: {e}"))?;
        Ok(Engine { tx, alive })
    }

    /// False once the thread has ended; the caller starts a new engine.
    pub fn alive(&self) -> bool {
        self.alive.load(Ordering::Relaxed)
    }

    pub fn send(&self, cmd: Cmd) {
        let _ = self.tx.send(cmd);
    }

    pub fn sender(&self) -> mpsc::Sender<Cmd> {
        self.tx.clone()
    }
}

struct Loaded {
    id: String,
    model: Model,
    session: Session,
}

struct Worker {
    emit: Emit,
    loaded: Option<Loaded>,
    load_error: Option<String>,
    idle: Option<Duration>,
    last_used: Instant,
}

/// Previews of a non-streaming model are skipped past this much audio; the
/// final pass still covers everything.
const PREVIEW_LIMIT: usize = RATE as usize * 30;

impl Worker {
    fn new(emit: Emit) -> Self {
        Worker {
            emit,
            loaded: None,
            load_error: None,
            idle: Some(Duration::from_secs(5 * 60)),
            last_used: Instant::now(),
        }
    }

    fn run(mut self, rx: mpsc::Receiver<Cmd>) {
        loop {
            let cmd = match (self.idle, self.loaded.is_some()) {
                (Some(idle), true) => {
                    let left = idle.saturating_sub(self.last_used.elapsed());
                    match rx.recv_timeout(left) {
                        Ok(c) => c,
                        Err(RecvTimeoutError::Timeout) => {
                            self.unload();
                            continue;
                        }
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                _ => match rx.recv() {
                    Ok(c) => c,
                    Err(_) => return,
                },
            };
            self.handle(cmd, &rx);
        }
    }

    fn handle(&mut self, cmd: Cmd, rx: &mpsc::Receiver<Cmd>) {
        match cmd {
            Cmd::Load { id, path } => self.load(id, path),
            Cmd::Unload => self.unload(),
            Cmd::Begin { language } => {
                // A panic inside the speech libraries must not take the engine
                // (and every later dictation) down with it. The pending reply
                // is dropped, which the caller reports as an engine failure.
                // (Release builds abort on panic, so this guards dev builds and
                // any future unwinding profile; the inputs are sanitized so the
                // known causes can't happen.)
                let caught = catch_unwind(AssertUnwindSafe(|| self.dictate(language, rx)));
                if caught.is_err() {
                    self.loaded = None; // its state can't be trusted now
                    (self.emit)(VoiceEvent::Error {
                        message: "The speech engine hit a problem and was restarted. Please try again.".into(),
                    });
                }
            }
            Cmd::SetIdle(d) => self.idle = d,
            // Strays from a dictation that was already cancelled.
            Cmd::Feed(_) | Cmd::Cancel => {}
            Cmd::Finish(reply) | Cmd::Commit(reply) => {
                let _ = reply.send(Ok(String::new()));
            }
        }
    }

    fn load(&mut self, id: String, path: PathBuf) {
        self.last_used = Instant::now();
        if self.loaded.as_ref().is_some_and(|l| l.id == id) {
            return;
        }
        self.loaded = None;
        self.load_error = None;
        (self.emit)(VoiceEvent::Phase { phase: "loading" });
        let started = Instant::now();
        let result: Result<Loaded, String> = catch_unwind(AssertUnwindSafe(|| {
            Model::load(&path)
                .and_then(|model| {
                    let session = model.session()?;
                    Ok(Loaded { id: id.clone(), model, session })
                })
                .map_err(|e| e.to_string())
        }))
        .unwrap_or_else(|_| Err("the engine stopped while loading it".into()));
        match result {
            Ok(l) => {
                (self.emit)(VoiceEvent::Loaded {
                    model: id,
                    ms: started.elapsed().as_millis() as u64,
                    backend: l.model.backend(),
                });
                self.loaded = Some(l);
            }
            Err(e) => {
                let msg = format!("The voice model could not be loaded: {e}");
                (self.emit)(VoiceEvent::Error {
                    message: msg.clone(),
                });
                self.load_error = Some(msg);
            }
        }
        self.last_used = Instant::now();
    }

    fn unload(&mut self) {
        if self.loaded.take().is_some() {
            (self.emit)(VoiceEvent::Unloaded);
        }
    }

    fn dictate(&mut self, language: Option<String>, rx: &mpsc::Receiver<Cmd>) {
        self.last_used = Instant::now();
        // Settings that arrive mid-dictation (the idle timer is sent right
        // after a start) are applied once it ends.
        let mut deferred = Vec::new();
        self.dictate_inner(language, rx, &mut deferred);
        self.last_used = Instant::now();
        for cmd in deferred {
            self.handle(cmd, rx);
        }
    }

    fn dictate_inner(
        &mut self,
        language: Option<String>,
        rx: &mpsc::Receiver<Cmd>,
        deferred: &mut Vec<Cmd>,
    ) {
        let Some(loaded) = self.loaded.as_mut() else {
            // Nothing to transcribe with; drain this dictation and explain.
            let err = self
                .load_error
                .clone()
                .unwrap_or_else(|| "The voice model is not loaded.".into());
            drain_until_end(rx, Err(err), deferred);
            return;
        };
        let caps = loaded.model.capabilities();
        let options = RunOptions {
            // Only pass a hint the model knows; otherwise it detects or
            // has a single language anyway.
            language: language.filter(|l| caps.languages.iter().any(|x| x == l)),
            ..Default::default()
        };
        (self.emit)(VoiceEvent::Phase { phase: "listening" });
        if caps.supports_streaming {
            stream(&mut loaded.session, &options, rx, &self.emit, deferred);
        } else {
            // Moonshine decodes a bounded number of tokens per run ("intended
            // for short utterances"; it truncated a long dictation), but
            // reports no audio limit: give it at most 20 s at a time.
            let max = if caps.max_audio_ms > 0 {
                Some((caps.max_audio_ms as usize) * RATE as usize / 1000)
            } else if loaded.model.arch().contains("moonshine") {
                Some(RATE as usize * 20)
            } else {
                None
            };
            batch(&mut loaded.session, &options, max, rx, &self.emit, deferred);
        }
    }
}

/// Keep commands that must not be lost during a dictation for afterwards.
fn defer(cmd: Cmd, deferred: &mut Vec<Cmd>) {
    if matches!(cmd, Cmd::Load { .. } | Cmd::Unload | Cmd::SetIdle(_)) {
        deferred.push(cmd);
    }
}

/// Swallow a dictation's remaining commands and answer its Finish.
fn drain_until_end(
    rx: &mpsc::Receiver<Cmd>,
    answer: Result<String, String>,
    deferred: &mut Vec<Cmd>,
) {
    while let Ok(cmd) = rx.recv() {
        match cmd {
            Cmd::Finish(reply) => {
                let _ = reply.send(answer);
                return;
            }
            Cmd::Commit(reply) => {
                let _ = reply.send(answer.clone());
            }
            Cmd::Cancel => return,
            other => defer(other, deferred),
        }
    }
}

/// Text events are capped at about 15 a second.
const TEXT_EVERY: Duration = Duration::from_millis(66);

fn stream(
    session: &mut Session,
    options: &RunOptions,
    rx: &mpsc::Receiver<Cmd>,
    emit: &Emit,
    deferred: &mut Vec<Cmd>,
) {
    // One stream per stretch of speech: a Commit finalizes it, answers with its
    // text and starts a fresh one while the microphone keeps running.
    loop {
        let mut tracker = SpeechTracker::new();
        let mut s = match session.stream(options, &StreamOptions::default()) {
            Ok(s) => s,
            Err(e) => {
                drain_until_end(rx, Err(format!("Could not start transcribing: {e}")), deferred);
                return;
            }
        };
        let mut last_text = Instant::now() - TEXT_EVERY;
        let mut dirty = false;
        let finish = |s: &mut transcribe_cpp::Stream<'_>, tracker: &SpeechTracker| {
            s.finalize()
                .map(|_| {
                    let t = s.text();
                    let text = if t.full.trim().is_empty() { t.display() } else { t.full };
                    if tracker.heard() { clean(&text) } else { String::new() }
                })
                .map_err(|e| format!("Transcription failed: {e}"))
        };
        loop {
            let Ok(cmd) = rx.recv() else { return };
            match cmd {
                Cmd::Feed(pcm) => {
                    if let Some(speaking) = tracker.push(&pcm) {
                        emit(VoiceEvent::Speech { speaking });
                    }
                    if let Ok(u) = s.feed(&pcm) {
                        dirty |= u.committed_changed || u.tentative_changed;
                    }
                    if dirty && last_text.elapsed() >= TEXT_EVERY {
                        let t = s.text();
                        emit(VoiceEvent::Text { committed: t.committed, tentative: t.tentative });
                        last_text = Instant::now();
                        dirty = false;
                    }
                }
                Cmd::Commit(reply) => {
                    let _ = reply.send(finish(&mut s, &tracker));
                    emit(VoiceEvent::Text { committed: String::new(), tentative: String::new() });
                    break; // next stretch
                }
                Cmd::Finish(reply) => {
                    emit(VoiceEvent::Phase { phase: "transcribing" });
                    let _ = reply.send(finish(&mut s, &tracker));
                    return;
                }
                Cmd::Cancel => return,
                other => defer(other, deferred),
            }
        }
    }
}

fn batch(
    session: &mut Session,
    options: &RunOptions,
    max_samples: Option<usize>,
    rx: &mpsc::Receiver<Cmd>,
    emit: &Emit,
    deferred: &mut Vec<Cmd>,
) {
    let mut tracker = SpeechTracker::new();
    let mut audio: Vec<f32> = Vec::with_capacity(RATE as usize * 30);
    let mut last_preview = Instant::now();
    let mut preview_cost = Duration::ZERO;
    let mut previewed_len = 0;
    let run = |session: &mut Session, tracker: &SpeechTracker, audio: &[f32]| {
        if !tracker.heard() {
            return Ok(String::new());
        }
        let (a, b) = tracker.speech_bounds(audio.len());
        transcribe(session, options, &audio[a..b], max_samples)
    };
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(Cmd::Feed(pcm)) => {
                if let Some(speaking) = tracker.push(&pcm) {
                    emit(VoiceEvent::Speech { speaking });
                }
                audio.extend_from_slice(&pcm);
            }
            Ok(Cmd::Commit(reply)) => {
                let _ = reply.send(run(session, &tracker, &audio));
                emit(VoiceEvent::Text { committed: String::new(), tentative: String::new() });
                audio.clear();
                tracker = SpeechTracker::new();
                previewed_len = 0;
                continue;
            }
            Ok(Cmd::Finish(reply)) => {
                emit(VoiceEvent::Phase { phase: "transcribing" });
                let _ = reply.send(run(session, &tracker, &audio));
                return;
            }
            Ok(Cmd::Cancel) | Err(RecvTimeoutError::Disconnected) => return,
            Ok(other) => defer(other, deferred),
            Err(RecvTimeoutError::Timeout) => {}
        }
        // A preview while speaking, at most a third of the time, so it never
        // falls behind the speaker.
        let due = last_preview.elapsed() >= Duration::from_millis(900).max(preview_cost * 3);
        if due && tracker.heard() && audio.len() <= PREVIEW_LIMIT && audio.len() > previewed_len + RATE as usize / 4 {
            let started = Instant::now();
            if let Ok(text) = run(session, &tracker, &audio) {
                emit(VoiceEvent::Text { committed: String::new(), tentative: text });
            }
            preview_cost = started.elapsed();
            last_preview = Instant::now();
            previewed_len = audio.len();
        }
    }
}

/// Run a clip, split into pieces the model accepts.
fn transcribe(
    session: &mut Session,
    options: &RunOptions,
    clip: &[f32],
    max: Option<usize>,
) -> Result<String, String> {
    let mut parts = Vec::new();
    for piece in split_for_model(clip, max) {
        let padded;
        // Very short clips (a single word) decode better with a little room.
        let piece = if piece.len() < RATE as usize {
            padded = [piece, &vec![0.0; RATE as usize - piece.len()]].concat();
            &padded[..]
        } else {
            piece
        };
        let t = session
            .run(piece, options)
            .map_err(|e| format!("Transcription failed: {e}"))?;
        parts.push(t.text);
    }
    Ok(clean(&parts.join(" ")))
}

/// Cut a clip into pieces of at most `max` samples, at the quietest moment
/// near the end of each window so words are not split.
pub fn split_for_model(clip: &[f32], max: Option<usize>) -> Vec<&[f32]> {
    let Some(max) = max.filter(|m| *m > RATE as usize * 2 && clip.len() > *m) else {
        return vec![clip];
    };
    let win = (RATE / 10) as usize;
    let mut out = Vec::new();
    let mut start = 0;
    while clip.len() - start > max {
        let lo = start + max * 7 / 10;
        let hi = start + max - win;
        let mut cut = hi;
        let mut best = f32::MAX;
        let mut i = lo;
        while i + win <= hi {
            let e: f32 = clip[i..i + win].iter().map(|x| x * x).sum();
            if e < best {
                best = e;
                cut = i + win / 2;
            }
            i += win / 2;
        }
        out.push(&clip[start..cut]);
        start = cut;
    }
    out.push(&clip[start..]);
    out
}

/// Tidy model output: one line of single-spaced text, without the
/// non-speech captions some models emit for silence or noise.
pub fn clean(text: &str) -> String {
    let joined = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let t = joined.trim();
    let bracketed = |o: char, c: char| {
        t.starts_with(o) && t.ends_with(c) && t[1..t.len() - 1].find(c).is_none()
    };
    if t.is_empty() || bracketed('[', ']') || bracketed('(', ')') || bracketed('*', '*') {
        return String::new();
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_drops_captions_and_extra_space() {
        assert_eq!(clean("  Hello   there.\n"), "Hello there.");
        assert_eq!(clean("[BLANK_AUDIO]"), "");
        assert_eq!(clean(" (music) "), "");
        assert_eq!(clean("*sighs*"), "");
        assert_eq!(clean("(a) and (b)"), "(a) and (b)");
    }

    #[test]
    fn split_keeps_every_sample_and_respects_the_limit() {
        let max = RATE as usize * 10;
        // 25 s of tone with silent gaps every 4 s.
        let clip: Vec<f32> = (0..RATE as usize * 25)
            .map(|i| {
                if (i / RATE as usize) % 4 == 3 {
                    0.0
                } else {
                    0.3
                }
            })
            .collect();
        let parts = split_for_model(&clip, Some(max));
        assert!(parts.len() >= 3);
        assert_eq!(parts.iter().map(|p| p.len()).sum::<usize>(), clip.len());
        assert!(parts.iter().all(|p| p.len() <= max));
        // Cuts land in the silence.
        let mut at = 0;
        for p in &parts[..parts.len() - 1] {
            at += p.len();
            assert_eq!(clip[at], 0.0, "cut at {at} is not in a gap");
        }
        assert_eq!(split_for_model(&clip, None).len(), 1);
    }

    #[test]
    fn settings_sent_during_a_dictation_are_kept() {
        let mut d = Vec::new();
        defer(Cmd::SetIdle(None), &mut d);
        defer(Cmd::Unload, &mut d);
        defer(Cmd::Feed(vec![0.0]), &mut d);
        defer(Cmd::Begin { language: None }, &mut d);
        assert_eq!(d.len(), 2);
        // Without a model, a dictation is drained and its Finish answered.
        let (tx, rx) = mpsc::channel();
        tx.send(Cmd::Feed(vec![0.0; 10])).unwrap();
        tx.send(Cmd::SetIdle(Some(Duration::from_secs(1)))).unwrap();
        let (rtx, rrx) = mpsc::channel();
        tx.send(Cmd::Finish(rtx)).unwrap();
        let mut d = Vec::new();
        drain_until_end(&rx, Err("no model".into()), &mut d);
        assert_eq!(rrx.recv().unwrap(), Err("no model".to_string()));
        assert!(matches!(d.as_slice(), [Cmd::SetIdle(Some(_))]));
    }

    /// "Type at each pause": two stretches of speech, committed one after the
    /// other, come back separately and in order, with nothing lost. Needs a
    /// model and a WAV with a pause: `VOICE_TEST_MODEL=… VOICE_TEST_WAV2=…
    /// cargo test --release -- --ignored live_commit --nocapture`
    #[test]
    #[ignore]
    fn live_commit() {
        let model = std::env::var("VOICE_TEST_MODEL").expect("VOICE_TEST_MODEL");
        let wav = std::fs::read(std::env::var("VOICE_TEST_WAV2").expect("VOICE_TEST_WAV2")).unwrap();
        let pcm: Vec<f32> = wav[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();
        let (tx, rx) = mpsc::channel();
        let engine = Engine::spawn(Arc::new(move |e| {
            let _ = tx.send(e);
        }))
        .unwrap();
        engine.send(Cmd::Load { id: "t".into(), path: model.into() });
        engine.send(Cmd::Begin { language: None });
        let half = pcm.len() / 2;
        for c in pcm[..half].chunks(1600) {
            engine.send(Cmd::Feed(c.to_vec()));
        }
        let (c1, r1) = mpsc::channel();
        engine.send(Cmd::Commit(c1));
        for c in pcm[half..].chunks(1600) {
            engine.send(Cmd::Feed(c.to_vec()));
        }
        let (c2, r2) = mpsc::channel();
        engine.send(Cmd::Finish(c2));
        let first = r1.recv_timeout(Duration::from_secs(120)).unwrap().unwrap();
        let second = r2.recv_timeout(Duration::from_secs(120)).unwrap().unwrap();
        let speech: Vec<bool> = rx
            .try_iter()
            .filter_map(|e| match e {
                VoiceEvent::Speech { speaking } => Some(speaking),
                _ => None,
            })
            .collect();
        println!("first: {first:?}\nsecond: {second:?}\nspeech events: {speech:?}");
        assert!(first.to_lowercase().contains("apple"), "{first}");
        assert!(second.to_lowercase().contains("banana"), "{second}");
        assert!(!first.to_lowercase().contains("banana") && !second.to_lowercase().contains("apple"));
        assert!(speech.contains(&true) && speech.contains(&false), "speech start and stop reported");
    }

    /// Benchmark: every clip in `VOICE_BENCH_DIR/manifest.json` through the
    /// full engine path (voice detection, trimming, model, final pass), one
    /// model load. Prints `BENCH {json}` per clip for tests/voice-bench.mjs.
    #[test]
    #[ignore]
    fn live_bench() {
        let model = std::env::var("VOICE_TEST_MODEL").expect("VOICE_TEST_MODEL");
        let dir = std::path::PathBuf::from(std::env::var("VOICE_BENCH_DIR").expect("VOICE_BENCH_DIR"));
        let manifest: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(dir.join("manifest.json")).unwrap()).unwrap();
        let (tx, _rx) = mpsc::channel();
        let engine = Engine::spawn(Arc::new(move |e| {
            let _ = tx.send(e);
        }))
        .unwrap();
        let started = Instant::now();
        engine.send(Cmd::Load { id: "bench".into(), path: model.clone().into() });
        // Warm up (first Metal use compiles kernels) so timings are per clip.
        engine.send(Cmd::Begin { language: None });
        engine.send(Cmd::Feed(vec![0.0; 16_000]));
        let (w, wr) = mpsc::channel();
        engine.send(Cmd::Finish(w));
        let _ = wr.recv_timeout(Duration::from_secs(300));
        println!("BENCH {}", serde_json::json!({ "load_ms": started.elapsed().as_millis() as u64 }));
        for clip in &manifest {
            let wav = std::fs::read(dir.join(clip["file"].as_str().unwrap())).unwrap();
            let pcm: Vec<f32> = wav[44..]
                .chunks_exact(2)
                .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
                .collect();
            let language = clip["language"].as_str().map(String::from);
            let t = Instant::now();
            engine.send(Cmd::Begin { language });
            for c in pcm.chunks(1600) {
                engine.send(Cmd::Feed(c.to_vec()));
            }
            let (r, rr) = mpsc::channel();
            engine.send(Cmd::Finish(r));
            let out = rr.recv_timeout(Duration::from_secs(600)).unwrap();
            println!(
                "BENCH {}",
                serde_json::json!({
                    "id": clip["id"],
                    "text": out.as_ref().map(|s| s.as_str()).unwrap_or(""),
                    "error": out.as_ref().err(),
                    "ms": t.elapsed().as_millis() as u64,
                    "audio_ms": pcm.len() as u64 * 1000 / RATE as u64,
                })
            );
        }
    }

    /// Needs a model: `VOICE_TEST_MODEL=/path/moonshine-tiny-Q8_0.gguf
    /// VOICE_TEST_WAV=/path/16k-mono.wav cargo test -- --ignored live_transcribe`
    #[test]
    #[ignore]
    fn live_transcribe() {
        let model = std::env::var("VOICE_TEST_MODEL").expect("VOICE_TEST_MODEL");
        let wav = std::fs::read(std::env::var("VOICE_TEST_WAV").expect("VOICE_TEST_WAV")).unwrap();
        let pcm: Vec<f32> = wav[44..]
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0)
            .collect();
        let (tx, rx) = mpsc::channel();
        let emit: Emit = Arc::new(move |e| {
            let _ = tx.send(e);
        });
        let engine = Engine::spawn(emit).unwrap();
        engine.send(Cmd::Load {
            id: "test".into(),
            path: model.into(),
        });
        engine.send(Cmd::Begin { language: None });
        for c in pcm.chunks(1600) {
            engine.send(Cmd::Feed(c.to_vec()));
        }
        let (rtx, rrx) = mpsc::channel();
        engine.send(Cmd::Finish(rtx));
        let text = rrx.recv_timeout(Duration::from_secs(120)).unwrap().unwrap();
        println!("transcript: {text}");
        let events: Vec<_> = rx.try_iter().collect();
        assert!(events
            .iter()
            .any(|e| matches!(e, VoiceEvent::Loaded { .. })));
        assert!(text.to_lowercase().contains("fox"), "{text}");
    }
}
