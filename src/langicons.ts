/**
 * Small monogram "icons" for the code-block language picker: a rounded chip
 * tinted with each language's brand color (GitHub-linguist-ish) and a 1–2
 * character label. Self-contained — no icon-font dependency — and themeable
 * since the chip text color is chosen for contrast against the brand color.
 */

// Fence aliases → canonical language, so "js" and "javascript" share an icon.
const ALIAS_CANON: Record<string, string> = {
  js: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash",
  py: "python", rb: "ruby", "c++": "cpp", cs: "csharp", yml: "yaml",
  md: "markdown", rs: "rust", golang: "go",
};

const LANG_COLORS: Record<string, string> = {
  javascript: "#f1e05a", typescript: "#3178c6", jsx: "#61dafb", tsx: "#3178c6",
  json: "#cbcb41", json5: "#cbcb41", html: "#e34c26", css: "#563d7c", scss: "#c6538c",
  markdown: "#083fa1", rust: "#dea584", go: "#00add8", python: "#3572a5", java: "#b07219",
  c: "#555555", cpp: "#f34b7d", csharp: "#178600", ruby: "#701516", php: "#4f5d95",
  swift: "#f05138", kotlin: "#a97bff", bash: "#89e051", yaml: "#cb171e", toml: "#9c4221",
  sql: "#e38c00", dockerfile: "#384d54", diff: "#6b6b6b", xml: "#0060ac", lua: "#000080",
  r: "#198ce7", perl: "#0298c3", scala: "#c22d40", haskell: "#5e5086", elixir: "#6e4a7e",
  graphql: "#e10098", vue: "#41b883", ini: "#6b6b6b", mermaid: "#ff3670", d2: "#2030b0",
};

// Two-character labels where a single initial reads poorly (C vs C++ vs C#).
const LANG_LABELS: Record<string, string> = {
  javascript: "JS", typescript: "TS", jsx: "JX", tsx: "TX", cpp: "C+", csharp: "C#",
  go: "Go", rust: "Rs", ruby: "Rb", kotlin: "Kt", swift: "Sw",
  haskell: "Hs", scala: "Sc", python: "Py", php: "Ph", graphql: "GQ", mermaid: "Me", d2: "D2",
};

export interface LangIcon {
  label: string;
  color: string;
}

/** Resolve a fence language to its chip label + brand color. */
export function langIcon(lang: string): LangIcon {
  const l = lang.toLowerCase();
  const canon = ALIAS_CANON[l] ?? l;
  return {
    color: LANG_COLORS[canon] ?? "#8b8b8b",
    label: LANG_LABELS[canon] ?? (canon.charAt(0).toUpperCase() || "?"),
  };
}

/** Black or white text, whichever reads better on the given hex background. */
export function readableText(bg: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(bg);
  if (!m) return "#ffffff";
  const n = parseInt(m[1], 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.6 ? "#1a1a1a" : "#ffffff";
}
