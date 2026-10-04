//! The speech models Sarala offers. Each is a single GGUF file from the
//! `handy-computer` repositories on Hugging Face (public, no token), pinned to a
//! revision and SHA-256 so a download is reproducible and verified.

use serde::Serialize;

#[derive(Serialize, Clone, Copy, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub id: &'static str,
    pub label: &'static str,
    pub blurb: &'static str,
    /// Languages it understands: "en" or "multi".
    pub languages: &'static str,
    /// Shows words while you speak (vs. after you stop).
    pub streaming: bool,
    pub size: u64,
    pub license: &'static str,
    #[serde(skip)]
    pub file: &'static str,
    #[serde(skip)]
    pub repo: &'static str,
    #[serde(skip)]
    pub revision: &'static str,
    #[serde(skip)]
    pub sha256: &'static str,
}

impl ModelInfo {
    pub fn url(&self) -> String {
        format!(
            "https://huggingface.co/{}/resolve/{}/{}",
            self.repo, self.revision, self.file
        )
    }
}

pub const MODELS: &[ModelInfo] = &[
    ModelInfo {
        id: "parakeet-en",
        label: "Parakeet (English)",
        blurb: "Fast and accurate. Shows words as you speak.",
        languages: "en",
        streaming: true,
        size: 477_274_496,
        license: "CC-BY-4.0 (NVIDIA)",
        file: "parakeet-unified-en-0.6b-Q4_K_M.gguf",
        repo: "handy-computer/parakeet-unified-en-0.6b-gguf",
        revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
        sha256: "a8bf3de2b393bd14ead5a858c3748d5e3b07a20fdeabdd3b498fba4f463fa929",
    },
    ModelInfo {
        id: "whisper-small",
        label: "Whisper Small",
        blurb: "Around 99 languages. Text appears when you stop.",
        languages: "multi",
        streaming: false,
        size: 171_630_656,
        license: "Apache-2.0 (OpenAI)",
        file: "whisper-small-Q4_K_M.gguf",
        repo: "handy-computer/whisper-small-gguf",
        revision: "c0214bd34be9296695486f838e0142f900803159",
        sha256: "b204d2005a3e5d4fe6153bd61e5e8b32e757ff7b017ac8f61c6f051c2f80e939",
    },
    ModelInfo {
        id: "moonshine-base",
        label: "Moonshine Base (English)",
        blurb: "Small and quick, for older computers.",
        languages: "en",
        streaming: false,
        size: 77_476_480,
        license: "MIT (Useful Sensors)",
        file: "moonshine-base-Q8_0.gguf",
        repo: "handy-computer/moonshine-base-gguf",
        revision: "3ef112378a8cf46ac8b278d9bfa2d15c846704b8",
        sha256: "7f0027dfd857d310b63a85ef57cadf183da712cc374f85a648f8bc18aaa2efc8",
    },
    ModelInfo {
        id: "whisper-turbo",
        label: "Whisper Large v3 Turbo",
        blurb: "Most accurate, about 100 languages. Slower and larger.",
        languages: "multi",
        streaming: false,
        size: 536_069_728,
        license: "Apache-2.0 (OpenAI)",
        file: "whisper-large-v3-turbo-Q4_K_M.gguf",
        repo: "handy-computer/whisper-large-v3-turbo-gguf",
        revision: "5eaf945c7978e564bae5b28a5b1639dd93c2bfb1",
        sha256: "ecfe9b6beb4ab18fef49187cc968cc74b5168b94629c8830e2ca6b794c6e25ed",
    },
];

pub fn find(id: &str) -> Option<&'static ModelInfo> {
    MODELS.iter().find(|m| m.id == id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_entries_are_well_formed() {
        let mut ids = std::collections::HashSet::new();
        for m in MODELS {
            assert!(ids.insert(m.id), "duplicate id {}", m.id);
            assert_eq!(m.sha256.len(), 64);
            assert!(m.sha256.chars().all(|c| c.is_ascii_hexdigit()));
            assert_eq!(m.revision.len(), 40);
            assert!(m.file.ends_with(".gguf"));
            assert!(m
                .url()
                .starts_with("https://huggingface.co/handy-computer/"));
        }
    }
}
