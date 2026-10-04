//! Voice typing: speak, and the words are typed into the document.
//!
//! Everything runs on this computer. The only network use is downloading a
//! speech model once, when the user turns the feature on. No account, no keys,
//! and audio never leaves the machine.
//!
//! Pipeline (see docs/VOICE-INPUT-PLAN.md):
//!
//! ```text
//!  microphone ─ audio.rs ─► 16 kHz mono chunks ─► engine.rs (own thread) ─► text
//!                 │ level                             │ phase / live text
//!                 └──────────── "voice" events ───────┘
//! ```
//!
//! The frontend calls `voice_start`, then `voice_stop` (returns the text) or
//! `voice_cancel`. Models live in `<app data>/voice/models/`.
//!
//! The capture and engine code is behind the `voice` Cargo feature, because
//! the engine (transcribe-cpp) compiles C++ with CMake. Without it these
//! commands still exist and report that voice typing isn't in this build.

pub mod catalog;
mod permission;

#[cfg(feature = "voice")]
mod audio;
#[cfg(feature = "voice")]
mod engine;
#[cfg(feature = "voice")]
mod vad;

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

use catalog::ModelInfo;

/// Events on the `voice` channel.
#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "camelCase")]
#[cfg_attr(not(feature = "voice"), allow(dead_code))]
pub enum VoiceEvent {
    /// "loading", "listening" or "transcribing".
    Phase {
        phase: &'static str,
    },
    /// Microphone level, 0..1.
    Level {
        level: f32,
    },
    /// Live text: `committed` won't change, `tentative` may.
    Text {
        committed: String,
        tentative: String,
    },
    /// The speaker started or stopped talking.
    Speech {
        speaking: bool,
    },
    Loaded {
        model: String,
        ms: u64,
        backend: String,
    },
    Unloaded,
    Error {
        message: String,
    },
}

#[derive(Default)]
pub struct VoiceState {
    #[cfg(feature = "voice")]
    engine: Mutex<Option<engine::Engine>>,
    #[cfg(feature = "voice")]
    recording: Mutex<Option<audio::Recording>>,
    download: Arc<Mutex<Option<Child>>>,
}

#[cfg_attr(feature = "voice", allow(dead_code))]
const NOT_BUILT: &str = "Voice typing isn't included in this build of Sarala.";

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("voice")
        .join("models");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn model_path(app: &AppHandle, m: &ModelInfo) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(m.file))
}

fn partial_path(path: &Path) -> PathBuf {
    let mut p = path.as_os_str().to_owned();
    p.push(".partial");
    PathBuf::from(p)
}

fn find_model(id: &str) -> Result<&'static ModelInfo, String> {
    catalog::find(id).ok_or_else(|| format!("Unknown voice model \"{id}\"."))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    #[serde(flatten)]
    info: ModelInfo,
    installed: bool,
    /// Bytes of an unfinished download, which resumes from here.
    partial: u64,
}

#[tauri::command]
pub fn voice_supported() -> bool {
    cfg!(feature = "voice") && cpu_problem().is_none()
}

/// Why this computer can't run the speech engine, if it can't.
///
/// Release builds compile the engine for a portable x86-64 baseline with AVX2,
/// FMA and F16C (Intel Haswell / AMD Excavator, 2013 on; see the release
/// workflow's TRANSCRIBE_CMAKE_ARGS) rather than for the build machine. An
/// older processor would crash with an illegal instruction the moment the
/// engine ran, so it is refused up front with an explanation instead.
pub fn cpu_problem() -> Option<&'static str> {
    #[cfg(target_arch = "x86_64")]
    {
        let ok = std::arch::is_x86_feature_detected!("avx2")
            && std::arch::is_x86_feature_detected!("fma")
            && std::arch::is_x86_feature_detected!("f16c");
        if !ok {
            return Some("Voice typing needs a processor with AVX2 (most computers made since 2013). This one doesn't have it.");
        }
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Platform {
    /// "macos", "windows" or "linux".
    os: &'static str,
    /// "snap" or "flatpak" when sandboxed: they control microphone access.
    sandbox: Option<&'static str>,
    /// Set when voice typing can't work here, with the reason.
    unsupported: Option<String>,
}

#[tauri::command]
pub fn voice_platform() -> Platform {
    let sandbox = if std::env::var_os("SNAP").is_some() {
        Some("snap")
    } else if std::env::var_os("FLATPAK_ID").is_some() || Path::new("/.flatpak-info").exists() {
        Some("flatpak")
    } else {
        None
    };
    let unsupported = if !cfg!(feature = "voice") {
        Some(NOT_BUILT.to_string())
    } else {
        cpu_problem().map(String::from)
    };
    Platform { os: std::env::consts::OS, sandbox, unsupported }
}

#[tauri::command]
pub fn voice_models(app: AppHandle) -> Result<Vec<ModelStatus>, String> {
    catalog::MODELS
        .iter()
        .map(|m| {
            let path = model_path(&app, m)?;
            Ok(ModelStatus {
                info: *m,
                installed: path.is_file(),
                partial: fs::metadata(partial_path(&path))
                    .map(|x| x.len())
                    .unwrap_or(0),
            })
        })
        .collect()
}

/* ---------- download ---------- */

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct DownloadEvent {
    model: String,
    /// "download", "verify", "done", "cancelled" or "error".
    phase: &'static str,
    received: u64,
    total: u64,
    message: Option<String>,
}

fn emit_download(
    app: &AppHandle,
    m: &ModelInfo,
    phase: &'static str,
    received: u64,
    message: Option<String>,
) {
    let _ = app.emit(
        "voice-download",
        DownloadEvent {
            model: m.id.into(),
            phase,
            received,
            total: m.size,
            message,
        },
    );
}

fn curl() -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new("curl");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    c
}

/// Download a model with the system `curl` (as the Pandoc download does, so no
/// HTTP crate is needed). The file is written to `<name>.partial`, resumed
/// with `-C -` if a previous attempt stopped, checked against the pinned
/// SHA-256, and only then renamed into place.
#[tauri::command]
pub async fn voice_download(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model: String,
) -> Result<(), String> {
    let m = find_model(&model)?;
    let slot = state.download.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = download_blocking(&app, m, &slot);
        match &result {
            Ok(true) => emit_download(&app, m, "done", m.size, None),
            Ok(false) => emit_download(&app, m, "cancelled", 0, None),
            Err(e) => emit_download(&app, m, "error", 0, Some(e.clone())),
        }
        result.map(|_| ())
    })
    .await
    .map_err(|e| format!("Download task failed: {e}"))?
}

/// Ok(false) when cancelled.
fn download_blocking(
    app: &AppHandle,
    m: &ModelInfo,
    slot: &Mutex<Option<Child>>,
) -> Result<bool, String> {
    let job = Fetch {
        url: m.url(),
        dest: model_path(app, m)?,
        size: m.size,
        sha256: m.sha256,
    };
    fetch(&job, slot, &|phase, got| {
        emit_download(app, m, phase, got, None)
    })
}

struct Fetch<'a> {
    url: String,
    dest: PathBuf,
    size: u64,
    sha256: &'a str,
}

/// Download `job.url` to `job.dest` through `<dest>.partial`, resuming a
/// previous attempt, then verify and rename. `progress` gets ("download",
/// bytes so far) and ("verify", size). Ok(false) when cancelled (the child in
/// `slot` was taken and killed).
fn fetch(
    job: &Fetch,
    slot: &Mutex<Option<Child>>,
    progress: &dyn Fn(&'static str, u64),
) -> Result<bool, String> {
    if job.dest.is_file() {
        return Ok(true);
    }
    let partial = partial_path(&job.dest);
    let mut have = fs::metadata(&partial).map(|x| x.len()).unwrap_or(0);
    if have > job.size {
        // Not this file (the pinned version changed): start over.
        let _ = fs::remove_file(&partial);
        have = 0;
    }
    if have < job.size {
        {
            let mut s = slot.lock().unwrap();
            if s.is_some() {
                return Err("Another model is downloading.".into());
            }
            let child = curl()
                .args([
                    "-fL",
                    "--retry",
                    "3",
                    "--retry-delay",
                    "2",
                    "-sS",
                    "-C",
                    "-",
                    "-H",
                    "User-Agent: sarala",
                    "-o",
                ])
                .arg(&partial)
                .arg(&job.url)
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| format!("Could not run curl: {e}"))?;
            *s = Some(child);
        }
        let status = loop {
            let done = {
                let mut s = slot.lock().unwrap();
                match s.as_mut() {
                    // Cancelled: voice_cancel_download took and killed it.
                    None => return Ok(false),
                    Some(child) => child.try_wait().map_err(|e| e.to_string())?,
                }
            };
            if let Some(status) = done {
                break status;
            }
            progress(
                "download",
                fs::metadata(&partial).map(|x| x.len()).unwrap_or(0),
            );
            std::thread::sleep(Duration::from_millis(250));
        };
        let mut child = slot.lock().unwrap().take();
        if !status.success() {
            let mut err = String::new();
            if let Some(stderr) = child.as_mut().and_then(|c| c.stderr.as_mut()) {
                let _ = stderr.read_to_string(&mut err);
            }
            let err = err.trim();
            return Err(if err.is_empty() {
                "The download failed. Check your connection and try again; it will resume.".into()
            } else {
                format!("The download failed ({err}). Try again; it will resume.")
            });
        }
    }
    progress("verify", job.size);
    let digest = sha256_file(&partial)?;
    if !digest.eq_ignore_ascii_case(job.sha256) {
        let _ = fs::remove_file(&partial);
        return Err(
            "The downloaded model was damaged (checksum mismatch). Please download it again."
                .into(),
        );
    }
    fs::rename(&partial, &job.dest).map_err(|e| format!("Could not save the model: {e}"))?;
    Ok(true)
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut h = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        h.update(&buf[..n]);
    }
    Ok(h.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

#[tauri::command]
pub fn voice_cancel_download(state: State<'_, VoiceState>) {
    if let Some(mut child) = state.download.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// Delete a model (and any unfinished download of it).
#[tauri::command]
pub fn voice_delete_model(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model: String,
) -> Result<(), String> {
    let m = find_model(&model)?;
    #[cfg(feature = "voice")]
    if let Some(e) = state.engine.lock().unwrap().as_ref() {
        e.send(engine::Cmd::Unload);
    }
    #[cfg(not(feature = "voice"))]
    let _ = state;
    let path = model_path(&app, m)?;
    let _ = fs::remove_file(partial_path(&path));
    match fs::remove_file(&path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}

/* ---------- permission & devices ---------- */

#[tauri::command]
pub fn voice_permission() -> &'static str {
    permission::status()
}

/// Shows the system prompt if the user hasn't decided yet (macOS).
#[tauri::command]
pub async fn voice_request_permission() -> Result<&'static str, String> {
    tauri::async_runtime::spawn_blocking(permission::request)
        .await
        .map_err(|e| e.to_string())
}

/// Input devices, default first. On macOS, listing them before the user has
/// allowed the microphone shows the system prompt (and blocks until it is
/// answered), so until then only "System default" is offered.
#[tauri::command]
pub async fn voice_devices() -> Result<Vec<String>, String> {
    #[cfg(feature = "voice")]
    return tauri::async_runtime::spawn_blocking(|| {
        if cfg!(target_os = "macos") && permission::status() != "granted" {
            return Vec::new();
        }
        audio::input_devices()
    })
    .await
    .map_err(|e| e.to_string());
    #[cfg(not(feature = "voice"))]
    Err(NOT_BUILT.into())
}

/* ---------- dictation ---------- */

#[cfg(feature = "voice")]
fn engine<'a>(
    app: &AppHandle,
    slot: &'a Mutex<Option<engine::Engine>>,
) -> Result<std::sync::MutexGuard<'a, Option<engine::Engine>>, String> {
    let mut g = slot.lock().unwrap();
    // Start one if there is none, or if the last one's thread has ended.
    if g.as_ref().is_none_or(|e| !e.alive()) {
        let app = app.clone();
        *g = Some(engine::Engine::spawn(Arc::new(move |e| {
            let _ = app.emit("voice", e);
        }))?);
    }
    Ok(g)
}

#[cfg(feature = "voice")]
fn load_cmd(app: &AppHandle, model: &str) -> Result<engine::Cmd, String> {
    if let Some(why) = cpu_problem() {
        return Err(why.into());
    }
    let m = find_model(model)?;
    let path = model_path(app, m)?;
    if !path.is_file() {
        return Err("model-missing".into());
    }
    Ok(engine::Cmd::Load {
        id: m.id.into(),
        path,
    })
}

/// Load a model ahead of time, so the first dictation starts instantly.
#[tauri::command]
pub fn voice_prepare(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model: String,
) -> Result<(), String> {
    #[cfg(feature = "voice")]
    {
        let cmd = load_cmd(&app, &model)?;
        engine(&app, &state.engine)?.as_ref().unwrap().send(cmd);
        Ok(())
    }
    #[cfg(not(feature = "voice"))]
    {
        let _ = (app, state, model);
        Err(NOT_BUILT.into())
    }
}

/// Start listening. Errors are short codes the UI explains
/// ("permission-denied", "model-missing") or a sentence.
#[tauri::command]
pub async fn voice_start(
    app: AppHandle,
    state: State<'_, VoiceState>,
    model: String,
    device: Option<String>,
    language: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "voice")]
    {
        let load = load_cmd(&app, &model)?;
        let status = tauri::async_runtime::spawn_blocking(permission::request)
            .await
            .map_err(|e| e.to_string())?;
        if status == "denied" || status == "restricted" {
            return Err("permission-denied".into());
        }
        if let Some(old) = state.recording.lock().unwrap().take() {
            old.cancel();
        }
        let tx = {
            let g = engine(&app, &state.engine)?;
            let e = g.as_ref().unwrap();
            // A dictation that is still open (a lost stop) is closed first.
            e.send(engine::Cmd::Cancel);
            e.send(load);
            e.send(engine::Cmd::Begin {
                language: language.filter(|l| !l.is_empty() && l != "auto"),
            });
            e.sender()
        };
        let level_app = app.clone();
        let feed = tx.clone();
        let recording = tauri::async_runtime::spawn_blocking(move || {
            audio::start(
                device,
                Box::new(move |pcm| {
                    let _ = feed.send(engine::Cmd::Feed(pcm));
                }),
                Box::new(move |level| {
                    let _ = level_app.emit("voice", VoiceEvent::Level { level });
                }),
            )
        })
        .await
        .map_err(|e| e.to_string())?;
        match recording {
            Ok(r) => {
                *state.recording.lock().unwrap() = Some(r);
                Ok(())
            }
            Err(e) => {
                let _ = tx.send(engine::Cmd::Cancel);
                Err(e)
            }
        }
    }
    #[cfg(not(feature = "voice"))]
    {
        let _ = (app, state, model, device, language);
        Err(NOT_BUILT.into())
    }
}

#[cfg(feature = "voice")]
fn reply_error(e: std::sync::mpsc::RecvTimeoutError) -> String {
    match e {
        std::sync::mpsc::RecvTimeoutError::Timeout => "Transcription took too long.".into(),
        // The engine thread dropped the request: it failed mid-dictation.
        std::sync::mpsc::RecvTimeoutError::Disconnected => {
            "The speech engine stopped unexpectedly. Please try again.".into()
        }
    }
}

/// Stop listening and return the text.
#[tauri::command]
pub async fn voice_stop(app: AppHandle, state: State<'_, VoiceState>) -> Result<String, String> {
    #[cfg(feature = "voice")]
    {
        let recording = state.recording.lock().unwrap().take();
        let tx = engine(&app, &state.engine)?.as_ref().unwrap().sender();
        tauri::async_runtime::spawn_blocking(move || {
            // Flush the microphone first so the last words reach the engine
            // before Finish (both go through the same channel, in order).
            if let Some(r) = recording {
                r.stop();
            }
            let (reply, rx) = std::sync::mpsc::channel();
            let _ = tx.send(engine::Cmd::Finish(reply));
            // Generous: the first run of a big model on a slow CPU can take a while.
            rx.recv_timeout(Duration::from_secs(300))
                .unwrap_or_else(|e| Err(reply_error(e)))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "voice"))]
    {
        let _ = (app, state);
        Err(NOT_BUILT.into())
    }
}

/// Type what was said so far and keep listening: returns the text of the
/// stretch of speech that just ended. The microphone is not touched, so no
/// words are lost between stretches.
#[tauri::command]
pub async fn voice_commit(app: AppHandle, state: State<'_, VoiceState>) -> Result<String, String> {
    #[cfg(feature = "voice")]
    {
        if state.recording.lock().unwrap().is_none() {
            return Ok(String::new());
        }
        let tx = engine(&app, &state.engine)?.as_ref().unwrap().sender();
        tauri::async_runtime::spawn_blocking(move || {
            let (reply, rx) = std::sync::mpsc::channel();
            let _ = tx.send(engine::Cmd::Commit(reply));
            rx.recv_timeout(Duration::from_secs(300))
                .unwrap_or_else(|e| Err(reply_error(e)))
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(feature = "voice"))]
    {
        let _ = (app, state);
        Err(NOT_BUILT.into())
    }
}

#[tauri::command]
pub fn voice_cancel(state: State<'_, VoiceState>) {
    #[cfg(feature = "voice")]
    {
        if let Some(r) = state.recording.lock().unwrap().take() {
            r.cancel();
        }
        if let Some(e) = state.engine.lock().unwrap().as_ref() {
            e.send(engine::Cmd::Cancel);
        }
    }
    #[cfg(not(feature = "voice"))]
    let _ = state;
}

/// Free the model's memory now.
#[tauri::command]
pub fn voice_unload(state: State<'_, VoiceState>) {
    #[cfg(feature = "voice")]
    if let Some(e) = state.engine.lock().unwrap().as_ref() {
        e.send(engine::Cmd::Unload);
    }
    #[cfg(not(feature = "voice"))]
    let _ = state;
}

/// Unload the model after this many idle minutes (0: right after each use;
/// None: keep it loaded).
#[tauri::command]
pub fn voice_set_idle(state: State<'_, VoiceState>, minutes: Option<u32>) {
    #[cfg(feature = "voice")]
    if let Some(e) = state.engine.lock().unwrap().as_ref() {
        e.send(engine::Cmd::SetIdle(
            minutes.map(|m| Duration::from_secs(m as u64 * 60)),
        ));
    }
    #[cfg(not(feature = "voice"))]
    let _ = (state, minutes);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_path_appends_suffix() {
        assert_eq!(
            partial_path(Path::new("/a/m.gguf")),
            PathBuf::from("/a/m.gguf.partial")
        );
    }

    #[test]
    fn sha256_of_known_bytes() {
        let dir = std::env::temp_dir().join(format!("sarala-voice-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let f = dir.join("abc");
        fs::write(&f, b"abc").unwrap();
        assert_eq!(
            sha256_file(&f).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("sarala-voice-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn file_url(p: &Path) -> String {
        format!("file://{}", p.display())
    }

    #[test]
    fn fetch_resumes_verifies_and_installs() {
        let dir = scratch("fetch");
        let src = dir.join("source.bin");
        let body: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
        fs::write(&src, &body).unwrap();
        let sha = sha256_file(&src).unwrap();
        let dest = dir.join("model.gguf");
        // A previous attempt stopped part way.
        fs::write(partial_path(&dest), &body[..70_000]).unwrap();
        let job = Fetch {
            url: file_url(&src),
            dest: dest.clone(),
            size: body.len() as u64,
            sha256: &sha,
        };
        let phases = Mutex::new(Vec::new());
        let ok = fetch(&job, &Mutex::new(None), &|p, _| {
            phases.lock().unwrap().push(p)
        })
        .unwrap();
        assert!(ok);
        assert_eq!(
            fs::read(&dest).unwrap(),
            body,
            "resumed file is complete and correct"
        );
        assert!(!partial_path(&dest).exists());
        assert!(phases.lock().unwrap().contains(&"verify"));
        // Already installed: nothing to do.
        assert!(fetch(&job, &Mutex::new(None), &|_, _| {}).unwrap());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fetch_rejects_a_damaged_download() {
        let dir = scratch("damaged");
        let src = dir.join("source.bin");
        fs::write(&src, vec![7u8; 50_000]).unwrap();
        let dest = dir.join("model.gguf");
        let wrong = "0".repeat(64);
        let job = Fetch {
            url: file_url(&src),
            dest: dest.clone(),
            size: 50_000,
            sha256: &wrong,
        };
        let err = fetch(&job, &Mutex::new(None), &|_, _| {}).unwrap_err();
        assert!(err.contains("checksum"), "{err}");
        assert!(
            !dest.exists() && !partial_path(&dest).exists(),
            "nothing damaged is kept"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fetch_starts_over_when_the_partial_is_too_big() {
        let dir = scratch("oversize");
        let src = dir.join("source.bin");
        fs::write(&src, vec![1u8; 10_000]).unwrap();
        let sha = sha256_file(&src).unwrap();
        let dest = dir.join("model.gguf");
        fs::write(partial_path(&dest), vec![9u8; 20_000]).unwrap();
        let job = Fetch {
            url: file_url(&src),
            dest: dest.clone(),
            size: 10_000,
            sha256: &sha,
        };
        assert!(fetch(&job, &Mutex::new(None), &|_, _| {}).unwrap());
        assert_eq!(fs::read(&dest).unwrap(), vec![1u8; 10_000]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fetch_reports_a_failed_transfer() {
        let dir = scratch("missing");
        let job = Fetch {
            url: file_url(&dir.join("nope.bin")),
            dest: dir.join("m.gguf"),
            size: 10,
            sha256: "x",
        };
        let err = fetch(&job, &Mutex::new(None), &|_, _| {}).unwrap_err();
        assert!(err.contains("download failed"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn events_serialize_with_kind_tag() {
        let v = serde_json::to_value(VoiceEvent::Text {
            committed: "a".into(),
            tentative: "b".into(),
        })
        .unwrap();
        assert_eq!(v["kind"], "text");
        assert_eq!(v["committed"], "a");
        let v = serde_json::to_value(VoiceEvent::Phase { phase: "listening" }).unwrap();
        assert_eq!(v["kind"], "phase");
    }
}

/// Real microphone, real model: records while macOS `say` speaks through the
/// speakers. `VOICE_TEST_MODEL=/path/model.gguf cargo test --release --
/// --ignored live_microphone --nocapture` (needs microphone access for the
/// terminal, and speakers the microphone can hear).
#[cfg(all(test, feature = "voice", target_os = "macos"))]
mod live {
    use super::*;
    use std::sync::mpsc;

    #[test]
    #[ignore]
    fn live_microphone() {
        println!("permission: {}", permission::status());
        let model = std::env::var("VOICE_TEST_MODEL").expect("VOICE_TEST_MODEL");
        let (etx, erx) = mpsc::channel();
        let engine = engine::Engine::spawn(Arc::new(move |e| {
            let _ = etx.send(e);
        }))
        .unwrap();
        engine.send(engine::Cmd::Load {
            id: "t".into(),
            path: model.into(),
        });
        engine.send(engine::Cmd::Begin { language: None });
        let feed = engine.sender();
        let peak = Arc::new(Mutex::new(0f32));
        let p = peak.clone();
        println!("devices: {:?}", audio::input_devices());
        let rec = audio::start(
            None,
            Box::new(move |pcm| {
                let _ = feed.send(engine::Cmd::Feed(pcm));
            }),
            Box::new(move |l| {
                let mut g = p.lock().unwrap();
                *g = g.max(l);
            }),
        )
        .expect("microphone");
        std::thread::sleep(Duration::from_millis(400));
        let _ = Command::new("say")
            .args([
                "-r",
                "170",
                "Sarala turns speech into text on this computer.",
            ])
            .status();
        std::thread::sleep(Duration::from_millis(600));
        rec.stop();
        let (tx, rx) = mpsc::channel();
        engine.send(engine::Cmd::Finish(tx));
        let text = rx.recv_timeout(Duration::from_secs(60)).unwrap();
        let live: Vec<_> = erx
            .try_iter()
            .filter(|e| matches!(e, VoiceEvent::Text { .. }))
            .collect();
        println!(
            "peak level {:.2}, {} live updates",
            *peak.lock().unwrap(),
            live.len()
        );
        println!("transcript: {text:?}");
    }
}
