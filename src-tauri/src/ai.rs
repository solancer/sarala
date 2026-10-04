//! AI assistant bridge: runs the user's own agent CLIs (Claude Code, OpenAI
//! Codex, GitHub Copilot CLI).
//!
//! Sarala stores no keys or tokens. Each CLI keeps its own sign-in (an OAuth
//! browser flow run by the CLI itself); Sarala only starts the CLI.
//!
//! A turn works on a private working copy: the frontend passes the current
//! Markdown, it is written to `<app cache>/ai-workspaces/<id>/document.md`,
//! the agent runs with that folder as its working directory and file tools
//! restricted to it, and when the process exits the (possibly edited) file is
//! sent back. The frontend turns the difference into proposals the user
//! accepts or rejects, so the agent never touches the user's real file.
//!
//! Output is forwarded line by line (each CLI prints JSONL) as `ai-agent`
//! events; parsing the lines is the frontend's job (src/ai/agents.ts).

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State};

const DOC_NAME: &str = "document.md";

#[derive(Deserialize, Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Agent {
    ClaudeCode,
    Codex,
    Copilot,
}

impl Agent {
    fn binary(self) -> &'static str {
        match self {
            Agent::ClaudeCode => "claude",
            Agent::Codex => "codex",
            Agent::Copilot => "copilot",
        }
    }

    fn login_args(self) -> &'static [&'static str] {
        match self {
            Agent::ClaudeCode => &["auth", "login"],
            Agent::Codex => &["login"],
            Agent::Copilot => &["login"],
        }
    }

    /// Arguments for one headless turn. The prompt is passed as a single
    /// argv entry (no shell), and tools are limited to reading and editing
    /// files in the working directory.
    fn run_args(self, prompt: &str, session: Option<&str>, model: Option<&str>) -> Vec<String> {
        let mut a: Vec<String> = Vec::new();
        let s = |v: &str| v.to_string();
        match self {
            Agent::ClaudeCode => {
                a.extend(["-p", prompt, "--output-format", "stream-json", "--verbose"].map(s));
                a.extend(
                    [
                        "--include-partial-messages",
                        "--permission-mode",
                        "acceptEdits",
                    ]
                    .map(s),
                );
                // --restricted drops command-running tools, ignores user and
                // project settings (hooks), and confines file tools to the cwd.
                a.extend(
                    [
                        "--restricted",
                        "--strict-mcp-config",
                        "--tools",
                        "Read,Edit,Write",
                    ]
                    .map(s),
                );
                if let Some(id) = session {
                    a.extend([s("--resume"), s(id)]);
                }
                if let Some(m) = model {
                    a.extend([s("--model"), s(m)]);
                }
            }
            Agent::Codex => {
                a.push(s("exec"));
                if let Some(id) = session {
                    a.extend([s("resume"), s(id)]);
                }
                // workspace-write: writes only inside the cwd; `-c` form
                // because `exec resume` has no --sandbox flag.
                a.extend(
                    [
                        "--json",
                        "--skip-git-repo-check",
                        "-c",
                        "sandbox_mode=\"workspace-write\"",
                    ]
                    .map(s),
                );
                if let Some(m) = model {
                    a.extend([s("-m"), s(m)]);
                }
                a.push(s(prompt));
            }
            Agent::Copilot => {
                a.extend(["-p", prompt, "--output-format", "json"].map(s));
                a.extend(["--allow-tool=write", "--deny-tool=shell", "--no-ask-user"].map(s));
                a.extend(
                    [
                        "--no-auto-update",
                        "--disable-builtin-mcps",
                        "--no-custom-instructions",
                    ]
                    .map(s),
                );
                if let Some(id) = session {
                    a.push(format!("--resume={id}"));
                }
                if let Some(m) = model {
                    a.extend([s("--model"), s(m)]);
                }
            }
        }
        a
    }
}

/// Directories searched for the CLIs. A GUI app on macOS doesn't inherit the
/// login shell's PATH, so the usual install locations are added explicitly.
/// The same list becomes the child's PATH, so npm-installed CLIs find `node`.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let mut extra: Vec<PathBuf> = Vec::new();
    if let Some(h) = &home {
        for rel in [
            ".local/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".volta/bin",
            ".cargo/bin",
            "bin",
        ] {
            extra.push(h.join(rel));
        }
    }
    for abs in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/snap/bin",
    ] {
        extra.push(PathBuf::from(abs));
    }
    if cfg!(windows) {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            extra.push(PathBuf::from(appdata).join("npm"));
        }
        if let Some(local) = std::env::var_os("LOCALAPPDATA") {
            extra.push(PathBuf::from(local).join("Programs"));
        }
    }
    for d in extra {
        if !dirs.contains(&d) {
            dirs.push(d);
        }
    }
    dirs
}

fn resolve(agent: Agent, override_path: Option<&str>) -> Option<PathBuf> {
    if let Some(p) = override_path.map(str::trim).filter(|p| !p.is_empty()) {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let names: Vec<String> = if cfg!(windows) {
        ["exe", "cmd", "bat"]
            .iter()
            .map(|e| format!("{}.{e}", agent.binary()))
            .collect()
    } else {
        vec![agent.binary().to_string()]
    };
    search_dirs()
        .into_iter()
        .flat_map(|d| names.iter().map(move |n| d.join(n)))
        .find(|p| p.is_file())
}

fn base_command(bin: &Path) -> Command {
    let mut cmd = Command::new(bin);
    let mut dirs = search_dirs();
    if let Some(parent) = bin.parent() {
        dirs.insert(0, parent.to_path_buf());
    }
    if let Ok(path) = std::env::join_paths(dirs) {
        cmd.env("PATH", path);
    }
    // Claude Code looks up its keychain entry by user name; make sure a
    // launch environment without USER (some launchers) still has one.
    #[cfg(unix)]
    if std::env::var_os("USER").is_none() {
        let user = std::env::var_os("LOGNAME").or_else(|| {
            std::env::var_os("HOME")
                .and_then(|h| PathBuf::from(h).file_name().map(|n| n.to_os_string()))
        });
        if let Some(user) = user {
            cmd.env("USER", user);
        }
    }
    cmd.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Run a short command and capture its output, giving up after `timeout`.
fn run_quick(mut cmd: Command, timeout: Duration) -> Option<(bool, String)> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut out = String::new();
                if let Some(mut o) = child.stdout.take() {
                    let _ = o.read_to_string(&mut out);
                }
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut out);
                }
                return Some((status.success(), out));
            }
            Ok(None) if start.elapsed() < timeout => thread::sleep(Duration::from_millis(50)),
            _ => {
                let _ = child.kill();
                return None;
            }
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentStatus {
    installed: bool,
    path: Option<String>,
    version: Option<String>,
    /// None when the CLI has no way to report it (Copilot).
    signed_in: Option<bool>,
    account: Option<String>,
}

fn status_blocking(agent: Agent, override_path: Option<String>) -> AgentStatus {
    let Some(bin) = resolve(agent, override_path.as_deref()) else {
        return AgentStatus {
            installed: false,
            path: None,
            version: None,
            signed_in: None,
            account: None,
        };
    };
    let quick = |args: &[&str]| {
        let mut c = base_command(&bin);
        c.args(args);
        run_quick(c, Duration::from_secs(8))
    };
    let version = quick(&["--version"])
        .filter(|(ok, _)| *ok)
        .and_then(|(_, out)| out.lines().next().map(|l| l.trim().to_string()));
    let (signed_in, account) = match agent {
        Agent::ClaudeCode => match quick(&["auth", "status"]) {
            Some((_, out)) => {
                let v: Option<serde_json::Value> = serde_json::from_str(out.trim()).ok();
                let logged = v
                    .as_ref()
                    .and_then(|v| v.get("loggedIn"))
                    .and_then(|b| b.as_bool());
                let who = v.as_ref().and_then(|v| {
                    let email = v.get("email").and_then(|e| e.as_str());
                    let method = v.get("authMethod").and_then(|e| e.as_str());
                    match (email, method) {
                        (Some(e), Some(m)) => Some(format!("{e} ({m})")),
                        (Some(e), None) => Some(e.to_string()),
                        (None, m) => m.map(str::to_string),
                    }
                });
                (logged, if logged == Some(true) { who } else { None })
            }
            None => (None, None),
        },
        Agent::Codex => match quick(&["login", "status"]) {
            Some((ok, out)) => {
                let line = out
                    .lines()
                    .map(str::trim)
                    .find(|l| !l.is_empty())
                    .map(str::to_string);
                let logged = ok && out.to_lowercase().contains("logged in");
                (Some(logged), if logged { line } else { None })
            }
            None => (None, None),
        },
        Agent::Copilot => (None, None),
    };
    AgentStatus {
        installed: true,
        path: Some(bin.to_string_lossy().into_owned()),
        version,
        signed_in,
        account,
    }
}

#[tauri::command]
pub async fn ai_agent_status(agent: Agent, path: Option<String>) -> Result<AgentStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status_blocking(agent, path))
        .await
        .map_err(|e| e.to_string())
}

/// Running agent and login processes, keyed by request id, so they can be
/// cancelled. The child sits behind `Arc<Mutex<..>>` because two owners need
/// it: the thread waiting for it to exit, and `ai_agent_cancel`.
#[derive(Default)]
pub struct AgentRuns(Mutex<HashMap<String, Arc<Mutex<Child>>>>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AgentEvent {
    request_id: String,
    /// "line" (one stdout line), "exit" (process finished), or "error".
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    code: Option<i32>,
    /// The working copy after the run (only on "exit" of an agent turn).
    #[serde(skip_serializing_if = "Option::is_none")]
    document: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stderr: Option<String>,
}

fn emit(app: &AppHandle, ev: AgentEvent) {
    let _ = app.emit("ai-agent", ev);
}

fn workspaces_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("ai-workspaces"))
}

fn workspace_dir(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid workspace id".into());
    }
    Ok(workspaces_root(app)?.join(id))
}

/// Working copies unused for this long are removed at startup. A chat's copy
/// must otherwise stay put: agent CLIs tie a resumable session to the folder
/// it ran in, and chats persist across restarts (see `ai_chats_save`).
const WORKSPACE_MAX_AGE: Duration = Duration::from_secs(60 * 60 * 24 * 30);

pub fn prune_workspaces(app: &AppHandle) {
    let Ok(root) = workspaces_root(app) else {
        return;
    };
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.elapsed().ok())
            .is_some_and(|age| age > WORKSPACE_MAX_AGE);
        if stale {
            let _ = fs::remove_dir_all(entry.path());
        }
    }
}

/* ---------- saved chats ---------- */

/// FNV-1a: a hash that is stable across Rust versions and platforms (the
/// std `DefaultHasher` is not), so a document keeps its chat file.
fn fnv1a(s: &str) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= u64::from(*b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    h
}

fn chats_file(app: &AppHandle, doc_path: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("ai-chats");
    Ok(dir.join(format!("{:016x}.json", fnv1a(doc_path))))
}

/// Chats saved for a document, or null. The file records the document path,
/// so a hash collision reads as "nothing saved" rather than someone else's chats.
#[tauri::command]
pub fn ai_chats_load(
    app: AppHandle,
    doc_path: String,
) -> Result<Option<serde_json::Value>, String> {
    let path = chats_file(&app, &doc_path)?;
    let Ok(text) = fs::read_to_string(&path) else {
        return Ok(None);
    };
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    if v.get("docPath").and_then(|p| p.as_str()) != Some(doc_path.as_str()) {
        return Ok(None);
    }
    Ok(v.get("data").cloned())
}

/// Save a document's chats (temp file + rename, like document saves).
#[tauri::command]
pub fn ai_chats_save(
    app: AppHandle,
    doc_path: String,
    data: serde_json::Value,
) -> Result<(), String> {
    let path = chats_file(&app, &doc_path)?;
    let dir = path.parent().ok_or("Invalid chats path")?;
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let body = serde_json::json!({ "docPath": doc_path, "data": data });
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec(&body).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn ai_chats_delete(app: AppHandle, doc_path: String) -> Result<(), String> {
    match fs::remove_file(chats_file(&app, &doc_path)?) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// Spawn `cmd`, forward stdout lines, keep the stderr tail, and emit "exit"
/// (with the working copy when `doc` is set) once it finishes.
fn spawn_streaming(
    app: AppHandle,
    runs: &AgentRuns,
    request_id: String,
    mut cmd: Command,
    doc: Option<PathBuf>,
) -> Result<(), String> {
    let mut child = cmd
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Could not start the agent: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let child = Arc::new(Mutex::new(child));
    runs.0
        .lock()
        .unwrap()
        .insert(request_id.clone(), child.clone());

    let tail: Arc<Mutex<Vec<String>>> = Arc::default();
    let err_thread = {
        let tail = tail.clone();
        thread::spawn(move || {
            let Some(err) = stderr else { return };
            for line in BufReader::new(err).lines().map_while(Result::ok) {
                let mut t = tail.lock().unwrap();
                t.push(line);
                if t.len() > 40 {
                    t.remove(0);
                }
            }
        })
    };

    thread::spawn(move || {
        if let Some(out) = stdout {
            for line in BufReader::new(out).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                emit(
                    &app,
                    AgentEvent {
                        request_id: request_id.clone(),
                        kind: "line",
                        data: Some(line),
                        code: None,
                        document: None,
                        stderr: None,
                    },
                );
            }
        }
        let code = child.lock().unwrap().wait().ok().and_then(|s| s.code());
        let _ = err_thread.join();
        // Cancelled runs were already removed from the map (and reported).
        let was_running = app
            .try_state::<AgentRuns>()
            .map(|r| r.0.lock().unwrap().remove(&request_id).is_some())
            .unwrap_or(true);
        if !was_running {
            return;
        }
        let document = doc.and_then(|p| fs::read_to_string(p).ok());
        let stderr = Some(tail.lock().unwrap().join("\n")).filter(|s| !s.is_empty());
        emit(
            &app,
            AgentEvent {
                request_id,
                kind: "exit",
                data: None,
                code,
                document,
                stderr,
            },
        );
    });
    Ok(())
}

/// Start one agent turn on the working copy for `workspace_id`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn ai_agent_run(
    app: AppHandle,
    runs: State<'_, AgentRuns>,
    request_id: String,
    agent: Agent,
    path: Option<String>,
    workspace_id: String,
    document: String,
    prompt: String,
    session_id: Option<String>,
    model: Option<String>,
) -> Result<(), String> {
    let bin = resolve(agent, path.as_deref()).ok_or_else(|| {
        format!(
            "`{}` was not found. Install it or set its path in Settings > AI.",
            agent.binary()
        )
    })?;
    let dir = workspace_dir(&app, &workspace_id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Same atomic write pattern as document saves.
    let doc_path = dir.join(DOC_NAME);
    let tmp = dir.join(format!(".{DOC_NAME}.tmp"));
    fs::write(&tmp, document.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &doc_path).map_err(|e| e.to_string())?;

    let session = session_id.as_deref().filter(|s| !s.trim().is_empty());
    let model = model.as_deref().map(str::trim).filter(|m| !m.is_empty());
    let mut cmd = base_command(&bin);
    cmd.current_dir(&dir)
        .args(agent.run_args(&prompt, session, model));
    spawn_streaming(app, &runs, request_id, cmd, Some(doc_path))
}

/// Run the CLI's own sign-in (it opens the provider's OAuth page in the
/// browser). Its output is streamed so device codes and URLs can be shown.
#[tauri::command]
pub fn ai_agent_login(
    app: AppHandle,
    runs: State<'_, AgentRuns>,
    request_id: String,
    agent: Agent,
    path: Option<String>,
) -> Result<(), String> {
    let bin = resolve(agent, path.as_deref())
        .ok_or_else(|| format!("`{}` was not found.", agent.binary()))?;
    let mut cmd = base_command(&bin);
    cmd.args(agent.login_args());
    spawn_streaming(app, &runs, request_id, cmd, None)
}

#[tauri::command]
pub fn ai_agent_cancel(app: AppHandle, runs: State<'_, AgentRuns>, request_id: String) {
    let child = runs.0.lock().unwrap().remove(&request_id);
    if let Some(child) = child {
        let _ = child.lock().unwrap().kill();
        emit(
            &app,
            AgentEvent {
                request_id,
                kind: "exit",
                data: None,
                code: None,
                document: None,
                stderr: Some("Stopped.".into()),
            },
        );
    }
}

/// Delete a chat's working copy (new chat, closed tab).
#[tauri::command]
pub fn ai_agent_forget(app: AppHandle, workspace_id: String) -> Result<(), String> {
    let dir = workspace_dir(&app, &workspace_id)?;
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::{fnv1a, status_blocking, Agent};

    #[test]
    fn chat_file_hash_is_stable() {
        // Pinned: changing it would orphan every saved chat file.
        assert_eq!(fnv1a(""), 0xcbf2_9ce4_8422_2325);
        assert_eq!(fnv1a("/Users/me/notes.md"), fnv1a("/Users/me/notes.md"));
        assert_ne!(fnv1a("/a.md"), fnv1a("/b.md"));
        assert_eq!(fnv1a("a"), 0xaf63_dc4c_8601_ec8c);
    }

    /// Talks to the CLIs installed on this machine, so it's opt-in:
    /// `cargo test live_status -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_status() {
        for agent in [Agent::ClaudeCode, Agent::Codex, Agent::Copilot] {
            let s = status_blocking(agent, None);
            println!(
                "{agent:?}: installed={} path={:?} version={:?} signed_in={:?} account={:?}",
                s.installed, s.path, s.version, s.signed_in, s.account
            );
        }
    }

    #[test]
    fn claude_args_restrict_tools_and_resume() {
        let a = Agent::ClaudeCode.run_args("hi", Some("abc"), Some("opus"));
        assert_eq!(a[0..2], ["-p", "hi"]);
        assert!(a.windows(2).any(|w| w == ["--tools", "Read,Edit,Write"]));
        assert!(a.contains(&"--restricted".to_string()));
        assert!(a.windows(2).any(|w| w == ["--resume", "abc"]));
        assert!(a.windows(2).any(|w| w == ["--model", "opus"]));
    }

    #[test]
    fn codex_resume_puts_session_before_flags_and_prompt_last() {
        let a = Agent::Codex.run_args("fix it", Some("t1"), None);
        assert_eq!(a[0..3], ["exec", "resume", "t1"]);
        assert_eq!(a.last().unwrap(), "fix it");
        assert!(a.contains(&"sandbox_mode=\"workspace-write\"".to_string()));
        let fresh = Agent::Codex.run_args("go", None, Some("gpt-5"));
        assert_eq!(fresh[0], "exec");
        assert_ne!(fresh[1], "resume");
    }

    #[test]
    fn copilot_denies_shell() {
        let a = Agent::Copilot.run_args("x", Some("s"), None);
        assert!(a.contains(&"--deny-tool=shell".to_string()));
        assert!(a.contains(&"--resume=s".to_string()));
    }
}
