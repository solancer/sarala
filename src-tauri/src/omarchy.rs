//! Read only Omarchy's published palette; do not run hooks or shell commands.
use std::path::{Path, PathBuf};

fn palette_paths(home: &Path, state: Option<PathBuf>, config: Option<PathBuf>) -> [PathBuf; 2] {
    [
        state
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".local/state"))
            .join("omarchy/current/theme/colors.toml"),
        config
            .filter(|path| path.is_absolute())
            .unwrap_or_else(|| home.join(".config"))
            .join("omarchy/current/theme/colors.toml"),
    ]
}

#[tauri::command]
pub fn read_omarchy_colors() -> Result<Option<String>, String> {
    #[cfg(target_os = "linux")]
    {
        use std::io::Read;
        let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
            return Ok(None);
        };
        let paths = palette_paths(
            &home,
            std::env::var_os("XDG_STATE_HOME").map(PathBuf::from),
            std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from),
        );
        for path in paths {
            let file = match std::fs::File::open(path) {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            let mut text = String::new();
            file.take(65537)
                .read_to_string(&mut text)
                .map_err(|e| e.to_string())?;
            if text.len() > 65536 {
                return Err("Omarchy palette is too large".into());
            }
            return Ok(Some(text));
        }
    }
    Ok(None)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn current_state_precedes_legacy_config() {
        let paths = palette_paths(Path::new("/home/test"), None, None);
        assert_eq!(
            paths[0],
            Path::new("/home/test/.local/state/omarchy/current/theme/colors.toml")
        );
        assert_eq!(
            paths[1],
            Path::new("/home/test/.config/omarchy/current/theme/colors.toml")
        );
    }

    #[test]
    fn xdg_paths_must_be_absolute() {
        let paths = palette_paths(
            Path::new("/home/test"),
            Some(PathBuf::from("/custom/state")),
            Some(PathBuf::from("relative/config")),
        );
        assert_eq!(
            paths[0],
            Path::new("/custom/state/omarchy/current/theme/colors.toml")
        );
        assert_eq!(
            paths[1],
            Path::new("/home/test/.config/omarchy/current/theme/colors.toml")
        );
    }
}
