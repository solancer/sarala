#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod menu;

use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use encoding_rs::Encoding;
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize)]
struct FileNode {
    name: String,
    path: String,
    is_dir: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    children: Option<Vec<FileNode>>,
}

const MARKDOWN_EXTS: &[&str] = &["md", "markdown", "mdown", "txt"];
const MAX_DEPTH: usize = 6;

fn walk(dir: &Path, depth: usize) -> Vec<FileNode> {
    let mut dirs: Vec<FileNode> = Vec::new();
    let mut files: Vec<FileNode> = Vec::new();

    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        if path.is_dir() {
            let children = if depth < MAX_DEPTH {
                walk(&path, depth + 1)
            } else {
                Vec::new()
            };
            // Skip directories with no markdown anywhere inside.
            if children.is_empty() {
                continue;
            }
            dirs.push(FileNode {
                name,
                path: path.to_string_lossy().to_string(),
                is_dir: true,
                children: Some(children),
            });
        } else {
            let is_md = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| MARKDOWN_EXTS.contains(&e.to_lowercase().as_str()))
                .unwrap_or(false);
            if is_md {
                files.push(FileNode {
                    name,
                    path: path.to_string_lossy().to_string(),
                    is_dir: false,
                    children: None,
                });
            }
        }
    }

    let by_name = |a: &FileNode, b: &FileNode| a.name.to_lowercase().cmp(&b.name.to_lowercase());
    dirs.sort_by(by_name);
    files.sort_by(by_name);
    dirs.extend(files);
    dirs
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<FileNode>, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    Ok(walk(p, 0))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| format!("Could not read {path}: {e}"))
}

/// A document decoded from disk, tagged with the detected encoding so the editor
/// can round-trip it (and show the encoding in the status bar).
#[derive(Serialize)]
struct EncodedDoc {
    content: String,
    encoding: String,
    had_bom: bool,
    /// True when decoding hit bytes that don't map cleanly (replacement chars):
    /// a hint that auto-detection guessed wrong and the user may want to repick.
    lossy: bool,
}

/// Decode raw bytes into a string. With `forced = None` we trust a BOM if one is
/// present, else sniff the encoding with `chardetng` (the detector Firefox uses).
/// With `forced = Some(enc)` we decode with exactly that encoding (the picker).
fn decode_bytes(bytes: &[u8], forced: Option<&'static Encoding>) -> EncodedDoc {
    if let Some(enc) = forced {
        let (cow, _, lossy) = enc.decode(bytes);
        return EncodedDoc {
            content: cow.into_owned(),
            encoding: enc.name().to_string(),
            had_bom: Encoding::for_bom(bytes).is_some(),
            lossy,
        };
    }
    if let Some((enc, _)) = Encoding::for_bom(bytes) {
        let (cow, _, lossy) = enc.decode(bytes);
        return EncodedDoc {
            content: cow.into_owned(),
            encoding: enc.name().to_string(),
            had_bom: true,
            lossy,
        };
    }
    let mut det = chardetng::EncodingDetector::new();
    det.feed(bytes, true);
    let enc = det.guess(None, true);
    let (cow, _, lossy) = enc.decode(bytes);
    EncodedDoc {
        content: cow.into_owned(),
        encoding: enc.name().to_string(),
        had_bom: false,
        lossy,
    }
}

#[tauri::command]
fn read_file_encoded(path: String) -> Result<EncodedDoc, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(decode_bytes(&bytes, None))
}

#[tauri::command]
fn reopen_with_encoding(path: String, label: String) -> Result<EncodedDoc, String> {
    let enc = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("Unknown encoding: {label}"))?;
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(decode_bytes(&bytes, Some(enc)))
}

/// Encode the document back to its on-disk byte form. `encoding_rs` has no UTF-16
/// *encoder* (the Encoding Standard never emits UTF-16), so we hand-roll UTF-16;
/// everything else (UTF-8, Shift_JIS, windows-1252, …) has a real encoder. A
/// UTF-8 BOM is added only when the original file had one.
fn encode_contents(contents: &str, label: Option<&str>, bom: bool) -> Result<Vec<u8>, String> {
    let label = label.unwrap_or("UTF-8");
    let enc = Encoding::for_label(label.as_bytes())
        .ok_or_else(|| format!("Unknown encoding: {label}"))?;
    if enc == encoding_rs::UTF_16LE || enc == encoding_rs::UTF_16BE {
        let little = enc == encoding_rs::UTF_16LE;
        let mut out = Vec::with_capacity(contents.len() * 2 + 2);
        if bom {
            out.extend_from_slice(if little { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
        }
        for unit in contents.encode_utf16() {
            if little {
                out.extend_from_slice(&unit.to_le_bytes());
            } else {
                out.extend_from_slice(&unit.to_be_bytes());
            }
        }
        return Ok(out);
    }
    if enc == encoding_rs::UTF_8 {
        let mut out = Vec::with_capacity(contents.len() + 3);
        if bom {
            out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
        }
        out.extend_from_slice(contents.as_bytes());
        return Ok(out);
    }
    let (cow, _, _) = enc.encode(contents);
    Ok(cow.into_owned())
}

#[derive(Serialize)]
struct LineMatch {
    line: usize,
    text: String,
}

#[derive(Serialize)]
struct FileMatches {
    path: String,
    name: String,
    matches: Vec<LineMatch>,
}

/// Collect markdown file paths under `dir`, applying the same hidden/build
/// directory skips as the workspace tree walk.
fn collect_md_files(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "target" {
            continue;
        }
        if path.is_dir() {
            if depth < MAX_DEPTH {
                collect_md_files(&path, depth + 1, out);
            }
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| MARKDOWN_EXTS.contains(&e.to_lowercase().as_str()))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
}

/// Full-text search across every markdown file in the open folder. Supports
/// plain, regex, case-sensitive, and whole-word modes; returns per-file line
/// matches (capped to keep the payload bounded).
#[tauri::command]
fn search_in_folder(
    root: String,
    query: String,
    regex: bool,
    case_sensitive: bool,
    whole_word: bool,
) -> Result<Vec<FileMatches>, String> {
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut pattern = if regex {
        query.clone()
    } else {
        regex::escape(&query)
    };
    if whole_word {
        pattern = format!(r"\b(?:{pattern})\b");
    }
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("Invalid pattern: {e}"))?;

    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("Not a directory: {root}"));
    }
    let mut files: Vec<PathBuf> = Vec::new();
    collect_md_files(root_path, 0, &mut files);
    files.sort();

    const MAX_TOTAL: usize = 2000;
    const MAX_PER_FILE: usize = 50;
    let mut results: Vec<FileMatches> = Vec::new();
    let mut total = 0usize;

    for path in files {
        if total >= MAX_TOTAL {
            break;
        }
        let Ok(content) = fs::read_to_string(&path) else {
            continue;
        };
        let mut matches: Vec<LineMatch> = Vec::new();
        for (idx, line) in content.lines().enumerate() {
            if matches.len() >= MAX_PER_FILE || total >= MAX_TOTAL {
                break;
            }
            if re.is_match(line) {
                let snippet: String = line.trim().chars().take(200).collect();
                matches.push(LineMatch {
                    line: idx + 1,
                    text: snippet,
                });
                total += 1;
            }
        }
        if !matches.is_empty() {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            results.push(FileMatches {
                path: path.to_string_lossy().to_string(),
                name,
                matches,
            });
        }
    }
    Ok(results)
}

#[tauri::command]
fn save_file(
    state: tauri::State<FileWatcher>,
    path: String,
    contents: String,
    encoding: Option<String>,
    bom: Option<bool>,
) -> Result<(), String> {
    let bytes = encode_contents(&contents, encoding.as_deref(), bom.unwrap_or(false))?;
    // Atomic-ish write: write to a sibling temp file, then rename over.
    let target = Path::new(&path);
    let tmp = target.with_extension("sarala.tmp");
    fs::write(&tmp, &bytes).map_err(|e| format!("Could not write {path}: {e}"))?;
    fs::rename(&tmp, target).map_err(|e| format!("Could not finalize {path}: {e}"))?;
    // Suppress the watcher's self-trigger: record the hash of what we just wrote
    // so the resulting filesystem event is recognised as our own save, not an
    // external edit. (The debounce window is far longer than this update.)
    let mut hashes = state.hashes.lock().unwrap();
    if hashes.contains_key(target) {
        hashes.insert(target.to_path_buf(), hash_bytes(&bytes));
    }
    Ok(())
}

/// Relaunch the running app. Used after the updater finishes installing a new
/// version: the frontend drives check/download/install (via the JS updater
/// plugin) and then calls this so the swap takes effect. `restart()` diverges
/// (it never returns — it re-execs the process), so this command has no result.
#[tauri::command]
fn relaunch(app: AppHandle) {
    app.restart();
}

#[tauri::command]
fn new_window(app: AppHandle) -> Result<(), String> {
    let label = format!(
        "main-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default()
    );
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::default())
        .title("Sarala")
        .inner_size(1120.0, 760.0)
        .min_inner_size(520.0, 400.0)
        .build()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<serde_json::Value, String> {
    let path = settings_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(text) => serde_json::from_str(&text).map_err(|e| e.to_string()),
        Err(_) => Ok(serde_json::json!({})),
    }
}

#[tauri::command]
fn save_settings(app: AppHandle, value: serde_json::Value) -> Result<(), String> {
    let path = settings_path(&app)?;
    let text = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
    fs::write(&path, text).map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_file(from: String, to: String) -> Result<(), String> {
    fs::rename(&from, &to).map_err(|e| format!("Could not rename {from}: {e}"))
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| format!("Could not delete {path}: {e}"))
}

/// Copy an image into `<doc_dir>/<subfolder>/`, deduplicating names, and
/// return the document-relative path to reference in markdown.
#[tauri::command]
fn copy_asset(src: String, doc_dir: String, subfolder: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    let stem = src_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("Bad source path: {src}"))?;
    let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    let target_dir = Path::new(&doc_dir).join(&subfolder);
    fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let mut name = if ext.is_empty() {
        stem.to_string()
    } else {
        format!("{stem}.{ext}")
    };
    let mut k = 1;
    while target_dir.join(&name).exists() {
        name = if ext.is_empty() {
            format!("{stem}-{k}")
        } else {
            format!("{stem}-{k}.{ext}")
        };
        k += 1;
    }
    fs::copy(src_path, target_dir.join(&name)).map_err(|e| format!("Could not copy {src}: {e}"))?;
    Ok(format!("{subfolder}/{name}"))
}

/// Reveal a file in the OS file manager (Finder / Explorer / default).
#[tauri::command]
fn reveal_in_dir(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let spawned = Command::new("open").args(["-R", &path]).spawn();
    #[cfg(target_os = "windows")]
    let spawned = Command::new("explorer")
        .arg(format!("/select,{path}"))
        .spawn();
    #[cfg(target_os = "linux")]
    let spawned = {
        let p = Path::new(&path);
        Command::new("xdg-open")
            .arg(p.parent().unwrap_or(p))
            .spawn()
    };
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

/// Copy a file into `dest_dir` (deduplicating the name); return the new path.
#[tauri::command]
fn copy_file_to(src: String, dest_dir: String) -> Result<String, String> {
    let src_path = Path::new(&src);
    let stem = src_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or_else(|| format!("Bad source path: {src}"))?;
    let ext = src_path.extension().and_then(|e| e.to_str()).unwrap_or("");
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    let mut name = if ext.is_empty() {
        stem.to_string()
    } else {
        format!("{stem}.{ext}")
    };
    let mut k = 1;
    while Path::new(&dest_dir).join(&name).exists() {
        name = if ext.is_empty() {
            format!("{stem}-{k}")
        } else {
            format!("{stem}-{k}.{ext}")
        };
        k += 1;
    }
    let target = Path::new(&dest_dir).join(&name);
    fs::copy(src_path, &target).map_err(|e| format!("Could not copy {src}: {e}"))?;
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
fn has_pandoc() -> bool {
    Command::new("pandoc")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

#[tauri::command]
fn pandoc_import(path: String) -> Result<String, String> {
    let out = Command::new("pandoc")
        .arg(&path)
        .args(["-t", "gfm", "--wrap=none"])
        .output()
        .map_err(|e| format!("Could not run pandoc: {e}"))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[tauri::command]
fn pandoc_export(
    markdown: String,
    output: String,
    format: String,
    flags: Vec<String>,
) -> Result<(), String> {
    let tmp = std::env::temp_dir().join("sarala-export.md");
    fs::write(&tmp, &markdown).map_err(|e| e.to_string())?;
    let out = Command::new("pandoc")
        .arg(&tmp)
        .args(["-f", "gfm", "-t", &format, "-o", &output])
        .args(&flags)
        .output()
        .map_err(|e| format!("Could not run pandoc: {e}"))?;
    let _ = fs::remove_file(&tmp);
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

/// A Chrome/Chromium/Edge binary usable for headless PDF printing.
fn find_chromium() -> Option<String> {
    let mac = [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
    for c in mac {
        if Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    for c in [
        "google-chrome",
        "google-chrome-stable",
        "chromium",
        "chromium-browser",
        "msedge",
    ] {
        if Command::new(c)
            .arg("--version")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false)
        {
            return Some(c.to_string());
        }
    }
    None
}

/// Render a standalone HTML string to a PDF via headless Chromium. Page size and
/// margins come from the HTML's @page CSS. Returns an error (so the caller can
/// fall back to the print dialog) when no Chromium is found.
#[tauri::command]
fn export_pdf(html: String, output: String) -> Result<(), String> {
    let chrome = find_chromium().ok_or("no_chromium")?;
    let tmp = std::env::temp_dir().join("sarala-print.html");
    fs::write(&tmp, &html).map_err(|e| e.to_string())?;
    let url = format!("file://{}", tmp.display());
    let out = Command::new(&chrome)
        .args([
            "--headless=new",
            "--disable-gpu",
            "--no-pdf-header-footer",
            &format!("--print-to-pdf={output}"),
            &url,
        ])
        .output()
        .map_err(|e| format!("Could not run {chrome}: {e}"))?;
    let _ = fs::remove_file(&tmp);
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

/// Run a user-configured shell command (export preset "run" after-action).
#[tauri::command]
fn run_command(command: String) -> Result<(), String> {
    if command.trim().is_empty() {
        return Ok(());
    }
    #[cfg(target_os = "windows")]
    let mut cmd = {
        let mut c = Command::new("cmd");
        c.args(["/C", &command]);
        c
    };
    #[cfg(not(target_os = "windows"))]
    let mut cmd = {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).into_owned());
    }
    Ok(())
}

/// File-watcher state. The debouncer watches the *parent dirs* of open files
/// (so atomic temp+rename saves are caught), and `hashes` records the last-known
/// content hash per tracked file. An event only matters when the on-disk hash
/// differs from what we recorded — which is how a save we just made ourselves is
/// told apart from an edit by another program. `hashes` is an `Arc` so the
/// debouncer's callback (set up once in `setup`) and the commands share it.
struct FileWatcher {
    debouncer: Mutex<Option<Debouncer<RecommendedWatcher>>>,
    watched: Mutex<HashSet<PathBuf>>,
    hashes: Arc<Mutex<HashMap<PathBuf, u64>>>,
}

fn hash_bytes(bytes: &[u8]) -> u64 {
    let mut h = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

#[tauri::command]
fn watch_file(state: tauri::State<FileWatcher>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let bytes = fs::read(&p).map_err(|e| format!("Could not read {path}: {e}"))?;
    state
        .hashes
        .lock()
        .unwrap()
        .insert(p.clone(), hash_bytes(&bytes));
    if let Some(parent) = p.parent().map(Path::to_path_buf) {
        let mut watched = state.watched.lock().unwrap();
        if !watched.contains(&parent) {
            if let Some(deb) = state.debouncer.lock().unwrap().as_mut() {
                deb.watcher()
                    .watch(&parent, RecursiveMode::NonRecursive)
                    .map_err(|e| e.to_string())?;
                watched.insert(parent);
            }
        }
    }
    Ok(())
}

/// Stop caring about a file's events (e.g. it was closed). We leave the parent
/// dir watched — sibling files may still be tracked, and re-watching is cheap.
#[tauri::command]
fn unwatch_file(state: tauri::State<FileWatcher>, path: String) {
    state.hashes.lock().unwrap().remove(&PathBuf::from(&path));
}

/// `<app_data_dir>/sessions`: where autosave shadows of dirty documents live.
fn shadow_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("sessions");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn write_shadow(app: AppHandle, key: String, data: serde_json::Value) -> Result<(), String> {
    let path = shadow_dir(&app)?.join(format!("{key}.json"));
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string(&data).map_err(|e| e.to_string())?;
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command]
fn clear_shadow(app: AppHandle, key: String) -> Result<(), String> {
    let path = shadow_dir(&app)?.join(format!("{key}.json"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn list_shadows(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let dir = shadow_dir(&app)?;
    let mut out = Vec::new();
    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) == Some("json") {
                if let Ok(text) = fs::read_to_string(&p) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        out.push(v);
                    }
                }
            }
        }
    }
    Ok(out)
}

/// Every installed font family name (sorted, de-duplicated). Powers the font
/// picker in Settings — the webview can't enumerate system fonts itself
/// (WKWebView has no Local Font Access API), so it asks Rust.
#[tauri::command]
fn list_system_fonts() -> Vec<String> {
    use font_kit::source::SystemSource;
    let mut names = SystemSource::new().all_families().unwrap_or_default();
    names.sort_by_key(|s| s.to_lowercase());
    names.dedup();
    names
}

#[derive(Serialize)]
struct FontFace {
    weight: u32,
    italic: bool,
    format: String,
    b64: String,
}

/// Base64 font data for a family's standard faces (regular / bold / italic /
/// bold-italic). The frontend turns these into `@font-face` data URIs so a
/// chosen system font can be embedded in an HTML/PDF export and travel to a
/// machine that doesn't have it installed.
#[tauri::command]
fn font_faces_b64(family: String) -> Result<Vec<FontFace>, String> {
    use base64::Engine;
    use font_kit::family_name::FamilyName;
    use font_kit::properties::{Properties, Style, Weight};
    use font_kit::source::SystemSource;

    let source = SystemSource::new();
    let combos = [
        (Weight::NORMAL, Style::Normal),
        (Weight::BOLD, Style::Normal),
        (Weight::NORMAL, Style::Italic),
        (Weight::BOLD, Style::Italic),
    ];

    let mut out: Vec<FontFace> = Vec::new();
    let mut seen: HashSet<u64> = HashSet::new();
    for (weight, style) in combos {
        let props = Properties {
            weight,
            style,
            ..Default::default()
        };
        let Ok(handle) = source.select_best_match(&[FamilyName::Title(family.clone())], &props)
        else {
            continue;
        };
        let Ok(font) = handle.load() else { continue };
        let Some(data) = font.copy_font_data() else {
            continue;
        };
        // The "best match" for Bold may resolve to the Regular file when the
        // family ships no bold; only emit each distinct face once.
        if !seen.insert(hash_bytes(&data[..])) {
            continue;
        }
        let actual = font.properties();
        let format = if data.len() >= 4 && &data[0..4] == b"OTTO" {
            "opentype"
        } else {
            "truetype"
        };
        out.push(FontFace {
            weight: actual.weight.0 as u32,
            italic: matches!(actual.style, Style::Italic | Style::Oblique),
            format: format.to_string(),
            b64: base64::engine::general_purpose::STANDARD.encode(&data[..]),
        });
    }
    Ok(out)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            // Auto-updater (desktop only). The plugin reads its pubkey/endpoints
            // from tauri.conf.json; the frontend invokes `plugin:updater|check`.
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;

            // File watcher: one debouncer for the whole app. Its callback and the
            // commands share `hashes` (an Arc), so the callback can tell our own
            // saves apart from external edits and emit only on the latter.
            let hashes: Arc<Mutex<HashMap<PathBuf, u64>>> = Arc::new(Mutex::new(HashMap::new()));
            let app_handle = app.handle().clone();
            let cb_hashes = hashes.clone();
            let debouncer = new_debouncer(
                Duration::from_millis(400),
                move |res: DebounceEventResult| {
                    let Ok(events) = res else { return };
                    let mut seen: HashSet<PathBuf> = HashSet::new();
                    for ev in events {
                        seen.insert(ev.path);
                    }
                    let mut map = cb_hashes.lock().unwrap();
                    for path in seen {
                        let Some(&known) = map.get(&path) else {
                            continue;
                        };
                        match fs::read(&path) {
                            Ok(bytes) => {
                                let h = hash_bytes(&bytes);
                                if h != known {
                                    map.insert(path.clone(), h);
                                    let _ = app_handle.emit(
                                        "external-change",
                                        serde_json::json!({ "path": path.to_string_lossy() }),
                                    );
                                }
                            }
                            Err(_) => {
                                map.remove(&path);
                                let _ = app_handle.emit(
                                    "external-removed",
                                    serde_json::json!({ "path": path.to_string_lossy() }),
                                );
                            }
                        }
                    }
                },
            )
            .ok();
            app.manage(FileWatcher {
                debouncer: Mutex::new(debouncer),
                watched: Mutex::new(HashSet::new()),
                hashes,
            });
            Ok(())
        })
        .on_menu_event(|app, event| {
            // Single pipe: every custom menu item forwards its id to the frontend
            // command bus; no editing logic lives on the Rust side.
            let _ = app.emit("menu", event.id().as_ref().to_string());
        })
        .invoke_handler(tauri::generate_handler![
            list_dir,
            read_file,
            read_file_encoded,
            reopen_with_encoding,
            search_in_folder,
            save_file,
            watch_file,
            unwatch_file,
            write_shadow,
            clear_shadow,
            list_shadows,
            new_window,
            relaunch,
            list_system_fonts,
            font_faces_b64,
            load_settings,
            save_settings,
            rename_file,
            delete_file,
            copy_asset,
            reveal_in_dir,
            copy_file_to,
            has_pandoc,
            pandoc_import,
            pandoc_export,
            export_pdf,
            run_command,
            menu::set_menu_checked,
            menu::set_menu_enabled,
            menu::update_recent_menu,
            menu::update_export_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running Sarala");
}

#[cfg(test)]
mod tests {
    use super::{
        decode_bytes, encode_contents, font_faces_b64, list_system_fonts, search_in_folder,
    };

    #[test]
    fn system_fonts_enumerate_and_embed() {
        let families = list_system_fonts();
        assert!(
            !families.is_empty(),
            "expected some installed font families"
        );
        // At least one family should yield embeddable (base64) face data.
        let any = families.iter().take(40).any(|f| {
            font_faces_b64(f.clone())
                .map(|faces| faces.iter().any(|face| !face.b64.is_empty()))
                .unwrap_or(false)
        });
        assert!(
            any,
            "expected at least one family to produce embeddable faces"
        );
    }

    #[test]
    fn search_spans_multiple_files_and_subdirs() {
        use std::fs;
        let dir = std::env::temp_dir().join(format!("sarala-search-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("sub")).unwrap();
        fs::write(dir.join("a.md"), "Alpha line\nsecond").unwrap();
        fs::write(dir.join("b.md"), "Another Alpha here").unwrap();
        fs::write(dir.join("sub/c.md"), "nested Alpha line").unwrap();

        let res = search_in_folder(
            dir.to_string_lossy().to_string(),
            "Alpha".to_string(),
            false,
            false,
            false,
        )
        .unwrap();
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(
            res.len(),
            3,
            "expected matches in 3 files, got {}",
            res.len()
        );
    }

    #[test]
    fn utf8_round_trips() {
        let bytes = encode_contents("héllo — café", None, false).unwrap();
        assert_eq!(bytes, "héllo — café".as_bytes());
        let doc = decode_bytes(&bytes, None);
        assert_eq!(doc.content, "héllo — café");
        assert_eq!(doc.encoding, "UTF-8");
        assert!(!doc.had_bom);
    }

    #[test]
    fn utf8_bom_is_added_and_detected() {
        let bytes = encode_contents("x", Some("UTF-8"), true).unwrap();
        assert_eq!(&bytes[..3], &[0xEF, 0xBB, 0xBF]);
        let doc = decode_bytes(&bytes, None);
        assert_eq!(doc.content, "x"); // BOM is stripped on decode
        assert!(doc.had_bom);
    }

    #[test]
    fn windows_1252_round_trips() {
        // "café" — é is a single byte 0xE9 in windows-1252.
        let bytes = encode_contents("café", Some("windows-1252"), false).unwrap();
        assert_eq!(bytes, vec![b'c', b'a', b'f', 0xE9]);
        let doc = decode_bytes(&bytes, Some(encoding_rs::WINDOWS_1252));
        assert_eq!(doc.content, "café");
        assert_eq!(doc.encoding, "windows-1252");
    }

    #[test]
    fn shift_jis_round_trips() {
        let bytes = encode_contents("日本語", Some("Shift_JIS"), false).unwrap();
        let doc = decode_bytes(&bytes, Some(encoding_rs::SHIFT_JIS));
        assert_eq!(doc.content, "日本語");
    }

    #[test]
    fn utf16le_hand_rolled_round_trips_with_bom() {
        let bytes = encode_contents("Hi—こ", Some("UTF-16LE"), true).unwrap();
        assert_eq!(&bytes[..2], &[0xFF, 0xFE]); // LE BOM
        let doc = decode_bytes(&bytes, None); // BOM sniff picks UTF-16LE
        assert_eq!(doc.content, "Hi—こ");
        assert!(doc.had_bom);
    }

    #[test]
    fn utf16be_round_trips() {
        let bytes = encode_contents("Hi—こ", Some("UTF-16BE"), true).unwrap();
        assert_eq!(&bytes[..2], &[0xFE, 0xFF]); // BE BOM
        let doc = decode_bytes(&bytes, None);
        assert_eq!(doc.content, "Hi—こ");
    }

    #[test]
    fn unknown_label_errors() {
        assert!(encode_contents("x", Some("not-an-encoding"), false).is_err());
    }
}
