use std::collections::HashMap;
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use tauri::{Emitter, Manager};

/// Retain Finder requests until the receiving editor has finished starting up.
#[derive(Default)]
pub struct FileOpenRequests {
    pending: Mutex<HashMap<String, Vec<String>>>,
    #[cfg(target_os = "macos")]
    ready: AtomicBool,
}

impl FileOpenRequests {
    /// Linux and Windows launchers pass documents as arguments (`Exec=sarala %F`
    /// in the .desktop entry) rather than as an OS event, so queue them for the
    /// main window up front.
    #[cfg(not(target_os = "macos"))]
    pub fn from_args(args: impl IntoIterator<Item = std::ffi::OsString>) -> Self {
        let requests = Self::default();
        let paths = launch_paths(args);
        if !paths.is_empty() {
            requests.push("main", paths);
        }
        requests
    }

    fn push(&self, label: &str, paths: Vec<String>) {
        self.pending
            .lock()
            .unwrap()
            .entry(label.into())
            .or_default()
            .extend(paths);
    }

    fn take(&self, label: &str) -> Vec<String> {
        self.pending
            .lock()
            .unwrap()
            .remove(label)
            .unwrap_or_default()
    }
}

/// The existing files among the launch arguments, as absolute paths. Flags and
/// anything that isn't a file (a typo, a GTK option) are ignored.
#[cfg(any(not(target_os = "macos"), test))]
fn launch_paths(args: impl IntoIterator<Item = std::ffi::OsString>) -> Vec<String> {
    args.into_iter()
        .map(std::path::PathBuf::from)
        .filter(|p| !p.to_string_lossy().starts_with('-') && p.is_file())
        .filter_map(|p| std::fs::canonicalize(p).ok())
        .map(|p| p.to_string_lossy().into_owned())
        .collect()
}

#[cfg(target_os = "macos")]
pub fn ready(app: &tauri::AppHandle) {
    app.state::<FileOpenRequests>()
        .ready
        .store(true, Ordering::Release);
}

#[tauri::command]
pub fn take_open_files(
    window: tauri::WebviewWindow,
    state: tauri::State<FileOpenRequests>,
) -> Vec<String> {
    state.take(window.label())
}

#[cfg(target_os = "macos")]
pub fn opened(app: &tauri::AppHandle, urls: Vec<tauri::Url>) {
    let paths: Vec<String> = urls
        .into_iter()
        .filter_map(|url| url.to_file_path().ok())
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    if paths.is_empty() {
        return;
    }

    let windows = app.webview_windows();
    let requests = app.state::<FileOpenRequests>();
    if windows.is_empty() && !requests.ready.load(Ordering::Acquire) {
        // macOS delivers launch documents before Tauri's Ready event. Tauri
        // will create the configured main window; creating it here would make
        // setup fail with a duplicate label. Its frontend drains this queue.
        requests.push("main", paths);
        return;
    }
    let window = windows
        .values()
        .find(|window| window.is_focused().unwrap_or(false))
        .cloned()
        .or_else(|| app.get_webview_window("main"))
        .or_else(|| windows.values().next().cloned())
        .or_else(|| {
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::default())
                .title("Sarala")
                .inner_size(1120.0, 760.0)
                .min_inner_size(520.0, 400.0)
                .build()
                .ok()
        });
    let Some(window) = window else { return };
    app.state::<FileOpenRequests>().push(window.label(), paths);
    // A notification is only a wake-up signal; the command drains the queue.
    // If the webview is not listening yet, its startup drain still gets these.
    let _ = app.emit_to(
        tauri::EventTarget::webview_window(window.label()),
        "open-files",
        (),
    );
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(test)]
mod tests {
    use super::{launch_paths, FileOpenRequests};

    #[test]
    fn launch_arguments_keep_only_existing_files() {
        let dir = std::env::temp_dir().join(format!("sarala-args-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("notes one.md");
        std::fs::write(&file, "# Hi").unwrap();
        let args = [
            file.clone().into_os_string(),
            "--gtk-flag".into(),
            dir.join("missing.md").into_os_string(),
            dir.clone().into_os_string(),
        ];
        let expected = std::fs::canonicalize(&file).unwrap();
        assert_eq!(
            launch_paths(args),
            vec![expected.to_string_lossy().into_owned()]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn retains_startup_requests_in_order_and_delivers_once_to_target_window() {
        let requests = FileOpenRequests::default();
        requests.push(
            "main",
            vec!["/tmp/first file.md".into(), "/tmp/日本語.md".into()],
        );
        requests.push("main", vec!["/tmp/third.markdown".into()]);
        assert!(requests.take("main-2").is_empty());
        assert_eq!(
            requests.take("main"),
            vec![
                "/tmp/first file.md",
                "/tmp/日本語.md",
                "/tmp/third.markdown"
            ]
        );
        assert!(requests.take("main").is_empty());
        requests.push("main", vec!["/tmp/later.mdown".into()]);
        assert_eq!(requests.take("main"), vec!["/tmp/later.mdown"]);
    }
}
