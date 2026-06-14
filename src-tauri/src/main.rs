#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod menu;

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
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
fn save_file(path: String, contents: String) -> Result<(), String> {
    // Atomic-ish write: write to a sibling temp file, then rename over.
    let target = Path::new(&path);
    let tmp = target.with_extension("sarala.tmp");
    fs::write(&tmp, &contents).map_err(|e| format!("Could not write {path}: {e}"))?;
    fs::rename(&tmp, target).map_err(|e| format!("Could not finalize {path}: {e}"))
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

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let menu = menu::build_menu(app.handle())?;
            app.set_menu(menu)?;
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
            search_in_folder,
            save_file,
            new_window,
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
