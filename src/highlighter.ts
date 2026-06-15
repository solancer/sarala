import { bumpRenderEpoch } from "./store";
import { setCodeHighlighter } from "./markdown";

/**
 * Syntax highlighting via Shiki (TextMate grammars + VS Code themes — the same
 * engine VS Code uses). Shiki loads asynchronously and is heavy, so it's
 * dynamically imported; until it's ready, code renders unhighlighted and a
 * renderEpoch bump re-renders it once loaded. codeToHtml is then synchronous,
 * fitting the live render pipeline. Dual light/dark themes are emitted as CSS
 * variables so switching themes needs no re-highlight, and the inline styles
 * make exported HTML self-contained.
 */

const LANGS = [
  "javascript", "typescript", "jsx", "tsx", "json", "json5", "html", "css", "scss",
  "markdown", "rust", "go", "python", "java", "c", "cpp", "csharp", "ruby", "php",
  "swift", "kotlin", "bash", "yaml", "toml", "sql", "dockerfile", "diff", "xml",
  "lua", "r", "perl", "scala", "haskell", "elixir", "graphql", "vue", "ini",
];

// Languages the app handles specially (not Shiki grammars) but should still be
// offered in the picker — `mermaid` and `d2` fences render as diagrams via
// markdown.ts.
const EXTRA_LANGS = ["mermaid", "d2"];

// Common fence aliases → a loaded grammar.
const ALIASES: Record<string, string> = {
  js: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash",
  py: "python", rb: "ruby", "c++": "cpp", cs: "csharp", yml: "yaml",
  md: "markdown", rs: "rust", golang: "go", dockerfile: "dockerfile",
};

interface Shiki {
  codeToHtml: (code: string, opts: Record<string, unknown>) => string;
}

let shiki: Shiki | null = null;
const loaded = new Set(LANGS);

async function initHighlighter(): Promise<void> {
  try {
    const { createHighlighter } = await import("shiki");
    shiki = (await createHighlighter({
      themes: ["github-light", "github-dark"],
      langs: LANGS,
    })) as unknown as Shiki;
    bumpRenderEpoch(); // re-render code now that highlighting is available
  } catch {
    shiki = null; // stay on the plain fallback
  }
}

function resolveLang(lang: string): string {
  const l = lang.toLowerCase();
  if (loaded.has(l)) return l;
  if (ALIASES[l] && loaded.has(ALIASES[l])) return ALIASES[l];
  return "text"; // built-in no-op grammar (themed box, no token colors)
}

/** Highlighted HTML for a code block, or null until Shiki has loaded. */
export function highlightCode(code: string, lang: string): string | null {
  if (!shiki) return null;
  try {
    return shiki.codeToHtml(code, {
      lang: resolveLang(lang),
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light",
    });
  } catch {
    return null;
  }
}

/** Languages offered by the code-block language picker. */
export function codeLanguages(): string[] {
  return [...new Set([...LANGS, ...EXTRA_LANGS, ...Object.keys(ALIASES)])].sort();
}

setCodeHighlighter(highlightCode);
void initHighlighter();
