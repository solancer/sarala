//! Keep COLRv1 colour fonts away from the AppImage's bundled WebKit (issue #45).
//!
//! The AppImage ships its own WebKitGTK, and the Skia inside it was built with
//! libstdc++ assertions on. Its COLRv1 code indexes a colour-stop vector out of
//! bounds when it paints a glyph that uses a gradient (for example U+1F50D in
//! Fedora's COLRv1 Noto Color Emoji), the assertion aborts the web process, and
//! the window freezes while the main process lives on. Native packages, the
//! Flatpak and the snap use the system WebKit and are not affected.
//!
//! The fix, applied at the bundle instead of asking users to change fonts: hide
//! every colour font from fontconfig and allow back only the bitmap (CBDT) Noto
//! Color Emoji the AppImage carries, which never reaches that Skia path.
//!
//! How it works: fontconfig reads the file named by `FONTCONFIG_FILE`. We write a
//! small config that includes the host's normal one, adds our font folder, and
//! adds a `<rejectfont>` for colour fonts with an `<acceptfont>` for ours
//! (fontconfig lets an accepted pattern override a rejected one; a `<glob>`
//! accept would not, so ours matches on `file`). The variable is set before
//! Tauri starts, so the WebKit web processes, which are child processes, inherit
//! it.

use std::path::{Path, PathBuf};

/// Where the AppImage bundle puts the emoji font (see `tauri.appimage.conf.json`).
const BUNDLED_FONT: &str = "usr/share/sarala/fonts/NotoColorEmoji.ttf";

/// Run first thing in `main`, before any thread exists: `set_var` is only safe
/// while the process is single-threaded.
pub fn apply() {
    // Both are exported by the AppImage runtime; outside an AppImage, do nothing.
    if std::env::var_os("APPIMAGE").is_none() {
        return;
    }
    let Some(appdir) = std::env::var_os("APPDIR").map(PathBuf::from) else {
        return;
    };
    let font = appdir.join(BUNDLED_FONT);
    let font = font.is_file().then_some(font);
    // Respect a config the user already points fontconfig at.
    let base = std::env::var_os("FONTCONFIG_FILE")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/etc/fonts/fonts.conf"));

    let dir = std::env::var_os("XDG_RUNTIME_DIR")
        .map(PathBuf::from)
        .filter(|d| d.is_dir())
        .unwrap_or_else(std::env::temp_dir);
    remove_stale_configs(&dir);
    // One file per process: the AppImage mounts at a new path on every launch,
    // so two running copies can't share a config.
    let path = dir.join(format!("sarala-fonts-{}.conf", std::process::id()));
    if std::fs::write(&path, config(&base, font.as_deref())).is_ok() {
        std::env::set_var("FONTCONFIG_FILE", &path);
    }
}

/// The fontconfig document. No DOCTYPE on purpose: fontconfig silently ignores a
/// config whose `fonts.dtd` it can't resolve, and this file lives in a temp dir.
fn config(base: &Path, font: Option<&Path>) -> String {
    let mut out = String::from("<?xml version=\"1.0\"?>\n<fontconfig>\n");
    out += &format!(
        "  <include ignore_missing=\"yes\">{}</include>\n",
        xml_escape(&base.to_string_lossy())
    );
    if let Some(font) = font {
        if let Some(dir) = font.parent() {
            out += &format!("  <dir>{}</dir>\n", xml_escape(&dir.to_string_lossy()));
        }
        // Prefer it for emoji even if the host config ranks another family first.
        out += "  <alias binding=\"strong\">\n    <family>emoji</family>\n    <prefer><family>Noto Color Emoji</family></prefer>\n  </alias>\n";
    }
    out += "  <selectfont>\n";
    if let Some(font) = font {
        out += &format!(
            "    <acceptfont><pattern><patelt name=\"file\"><string>{}</string></patelt></pattern></acceptfont>\n",
            xml_escape(&font.to_string_lossy())
        );
    }
    out += "    <rejectfont><pattern><patelt name=\"color\"><bool>true</bool></patelt></pattern></rejectfont>\n";
    out += "  </selectfont>\n</fontconfig>\n";
    out
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Delete configs left by earlier runs whose process is gone (a crash or a
/// killed process never cleans up after itself).
fn remove_stale_configs(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(pid) = name
            .to_str()
            .and_then(|n| n.strip_prefix("sarala-fonts-"))
            .and_then(|n| n.strip_suffix(".conf"))
        else {
            continue;
        };
        if pid.parse::<u32>().is_ok() && !Path::new("/proc").join(pid).exists() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_rejects_colour_fonts_and_accepts_the_bundled_one() {
        let font = Path::new("/tmp/.mount_Sarala1/usr/share/sarala/fonts/NotoColorEmoji.ttf");
        let conf = config(Path::new("/etc/fonts/fonts.conf"), Some(font));
        assert!(conf.contains("<include ignore_missing=\"yes\">/etc/fonts/fonts.conf</include>"));
        assert!(conf.contains("<dir>/tmp/.mount_Sarala1/usr/share/sarala/fonts</dir>"));
        assert!(conf.contains(&format!(
            "<acceptfont><pattern><patelt name=\"file\"><string>{}</string></patelt></pattern></acceptfont>",
            font.display()
        )));
        assert!(conf.contains("<patelt name=\"color\"><bool>true</bool></patelt>"));
        assert!(!conf.contains("DOCTYPE"));
    }

    #[test]
    fn config_without_bundled_font_still_rejects_colour_fonts() {
        let conf = config(Path::new("/etc/fonts/fonts.conf"), None);
        assert!(!conf.contains("<acceptfont>"));
        assert!(!conf.contains("<dir>"));
        assert!(conf.contains("<rejectfont>"));
    }

    #[test]
    fn paths_are_xml_escaped() {
        let conf = config(Path::new("/home/a&b/<fonts>.conf"), None);
        assert!(conf.contains("/home/a&amp;b/&lt;fonts&gt;.conf"));
    }
}
