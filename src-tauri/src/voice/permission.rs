//! Microphone permission.
//!
//! On macOS, an app without microphone access still gets an input stream, it
//! just delivers silence. So we ask AVFoundation directly: the status, and if
//! the user hasn't decided yet, the system prompt (which names Sarala and shows
//! `NSMicrophoneUsageDescription` from Info.plist).
//!
//! Windows has no prompt for desktop apps: two switches in Settings > Privacy
//! & security > Microphone ("Microphone access" and "Let desktop apps access
//! your microphone") either allow every desktop app or none, and a blocked app
//! typically records silence. Their state is in the registry under
//! `CapabilityAccessManager\ConsentStore\microphone` (machine and user), read
//! here with the built-in `reg` tool.
//!
//! Linux has no microphone permission outside sandboxes: a snap needs the
//! `audio-record` interface connected, a Flatpak the PulseAudio socket (granted
//! in the manifest). Both show up as a failed open or silence.

/// "granted", "denied", "restricted", "undetermined" or "unknown".
pub fn status() -> &'static str {
    imp::status()
}

/// Ask for access if undecided; returns the resulting status.
pub fn request() -> &'static str {
    imp::request()
}

#[cfg(target_os = "macos")]
mod imp {
    use std::sync::mpsc;
    use std::time::Duration;

    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {}

    /// `AVMediaTypeAudio`'s value.
    fn audio() -> objc2::rc::Retained<NSString> {
        NSString::from_str("soun")
    }

    pub fn status() -> &'static str {
        let media = audio();
        // AVAuthorizationStatus: 0 not determined, 1 restricted, 2 denied, 3 authorized.
        let s: isize =
            unsafe { msg_send![class!(AVCaptureDevice), authorizationStatusForMediaType: &*media] };
        match s {
            0 => "undetermined",
            1 => "restricted",
            2 => "denied",
            3 => "granted",
            _ => "unknown",
        }
    }

    pub fn request() -> &'static str {
        if status() != "undetermined" {
            return status();
        }
        let (tx, rx) = mpsc::channel::<bool>();
        // The completion handler runs on an arbitrary thread once the user answers.
        let handler = RcBlock::new(move |granted: Bool| {
            let _ = tx.send(granted.as_bool());
        });
        let media = audio();
        unsafe {
            let _: () = msg_send![
                class!(AVCaptureDevice),
                requestAccessForMediaType: &*media,
                completionHandler: &*handler
            ];
        }
        // Wait for the user, but don't hang forever if the prompt is ignored.
        let _ = rx.recv_timeout(Duration::from_secs(120));
        status()
    }
}

#[cfg(windows)]
mod imp {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    /// The `Value` (Allow/Deny) of a consent key, if set.
    fn consent(root: &str, sub: &str) -> Option<String> {
        let out = Command::new("reg")
            .args(["query", &format!(r"{root}\{KEY}{sub}"), "/v", "Value"])
            .creation_flags(0x0800_0000) // CREATE_NO_WINDOW
            .output()
            .ok()?;
        parse_value(&String::from_utf8_lossy(&out.stdout))
    }

    pub fn status() -> &'static str {
        let keys = [("HKLM", ""), ("HKCU", ""), ("HKLM", r"\NonPackaged"), ("HKCU", r"\NonPackaged")];
        let values: Vec<_> = keys.iter().filter_map(|(r, k)| consent(r, k)).collect();
        if values.iter().any(|v| v.eq_ignore_ascii_case("deny")) {
            "denied"
        } else if values.is_empty() {
            "unknown"
        } else {
            "granted"
        }
    }

    pub fn request() -> &'static str {
        status()
    }

    use super::parse_value;
}

/// The data of `Value    REG_SZ    Deny` in `reg query` output.
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_value(out: &str) -> Option<String> {
    out.lines().find_map(|l| {
        let mut parts = l.split_whitespace();
        (parts.next()? == "Value" && parts.next()? == "REG_SZ").then(|| parts.next().unwrap_or("").to_string())
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_reg_query_output() {
        let out = "\r\nHKEY_CURRENT_USER\\Software\\...\\microphone\r\n    Value    REG_SZ    Deny\r\n\r\n";
        assert_eq!(super::parse_value(out).as_deref(), Some("Deny"));
        assert_eq!(super::parse_value("ERROR: The system was unable to find the specified registry key"), None);
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod imp {
    pub fn status() -> &'static str {
        "unknown"
    }
    pub fn request() -> &'static str {
        "unknown"
    }
}
