import { assetsReady, whenIdle } from "./assets";
import { setCodeHighlighter } from "./markdown";
import { setLiveCodeHighlighter } from "./livesource";
import type { HighlighterCore, LanguageInput } from "shiki/core";

/**
 * Syntax highlighting via Shiki (TextMate grammars + VS Code themes — the same
 * engine VS Code uses). Shiki is heavy, so nothing loads at startup: the core,
 * regex engine and themes warm up once the app is idle, and each grammar loads
 * the first time a code block in that language renders. Until then code
 * renders plain; a highlightEpoch bump re-renders only blocks that hold code
 * fences once their grammars arrive. codeToHtml is then synchronous, fitting
 * the live render pipeline. Dual light/dark themes are emitted as CSS
 * variables so switching themes needs no re-highlight, and the inline styles
 * make exported HTML self-contained.
 */

type Loader = () => Promise<{ default: LanguageInput }>;
// Explicit imports so each grammar is its own lazily fetched chunk.
const LOADERS: Record<string, Loader> = {
  javascript: () => import("shiki/langs/javascript.mjs"),
  typescript: () => import("shiki/langs/typescript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  json5: () => import("shiki/langs/json5.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  xml: () => import("shiki/langs/xml.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  r: () => import("shiki/langs/r.mjs"),
  perl: () => import("shiki/langs/perl.mjs"),
  scala: () => import("shiki/langs/scala.mjs"),
  haskell: () => import("shiki/langs/haskell.mjs"),
  elixir: () => import("shiki/langs/elixir.mjs"),
  graphql: () => import("shiki/langs/graphql.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  ini: () => import("shiki/langs/ini.mjs"),
  // Complex-block editing cards: diagram, equation and front-matter sources.
  mermaid: () => import("shiki/langs/mermaid.mjs"),
  latex: () => import("shiki/langs/latex.mjs"),
};
const LANGS = Object.keys(LOADERS);

// Languages the app handles specially (not Shiki grammars) but should still be
// offered in the picker — `mermaid` and `d2` fences render as diagrams via
// markdown.ts.
const EXTRA_LANGS = ["mermaid", "d2"];

// Common fence aliases → a supported grammar.
const ALIASES: Record<string, string> = {
  js: "javascript", ts: "typescript", sh: "bash", shell: "bash", zsh: "bash",
  py: "python", rb: "ruby", "c++": "cpp", cs: "csharp", yml: "yaml",
  md: "markdown", rs: "rust", golang: "go", dockerfile: "dockerfile",
};

let shiki: HighlighterCore | null = null;
let corePromise: Promise<HighlighterCore> | null = null;
const ready = new Set<string>();
const loading = new Map<string, Promise<void>>();

function loadCore(): Promise<HighlighterCore> {
  corePromise ??= (async () => {
    const [{ createHighlighterCore }, { createOnigurumaEngine }] = await Promise.all([
      import("shiki/core"), import("shiki/engine/oniguruma"),
    ]);
    const core = await createHighlighterCore({
      themes: [import("shiki/themes/github-light.mjs"), import("shiki/themes/github-dark.mjs")],
      langs: [],
      engine: createOnigurumaEngine(import("shiki/wasm")),
    });
    shiki = core;
    return core;
  })();
  return corePromise;
}

// Loads requested in one render pass settle together, so a document with five
// languages re-renders its code once, not five times: refresh whenever the set
// of in-flight loads drains.
const inflight = new Set<Promise<void>>();
function scheduleRefresh(load: Promise<void>) {
  inflight.add(load);
  void load.then(() => {
    inflight.delete(load);
    if (!inflight.size) assetsReady();
  });
}

function requestLanguage(name: string | null): Promise<void> {
  const key = name ?? "";
  let load = loading.get(key);
  if (!load) {
    load = (async () => {
      const core = await loadCore();
      if (name) await core.loadLanguage((await LOADERS[name]()).default);
      if (name) ready.add(name);
    })().catch(() => { /* stay on the plain fallback */ });
    loading.set(key, load);
    scheduleRefresh(load);
  }
  return load;
}

/** Supported grammar for a fence's info string, or null for plain text. */
function grammarFor(lang: string): string | null {
  const l = lang.toLowerCase();
  if (l in LOADERS) return l;
  return ALIASES[l] ?? null;
}

/** Highlighted HTML for a code block, or null until its grammar has loaded. */
// Tokenizing is the expensive part of a code block's render; the output only
// depends on the resolved grammar and the code, so re-renders reuse it.
const htmlCache = new Map<string, string>();
export function highlightCode(code: string, lang: string): string | null {
  const name = grammarFor(lang);
  if (!shiki || (name && !ready.has(name))) {
    void requestLanguage(name);
    return null;
  }
  const resolved = name ?? "text"; // built-in no-op grammar (themed box, no token colors)
  const key = `${resolved}\0${code}`;
  const hit = htmlCache.get(key);
  if (hit !== undefined) return hit;
  try {
    const html = shiki.codeToHtml(code, {
      lang: resolved,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: "light",
    });
    if (htmlCache.size > 1000) htmlCache.clear();
    htmlCache.set(key, html);
    return html;
  } catch {
    return null;
  }
}

/** Load every grammar a document's fences need (exports render synchronously). */
export async function prepareHighlighting(md: string): Promise<void> {
  const langs = new Set<string | null>([null]);
  for (const m of md.matchAll(/^[ \t>]*(?:`{3,}|~{3,})[ \t]*([^\s`]+)/gm)) langs.add(grammarFor(m[1]));
  await Promise.all([...langs].map(requestLanguage));
}

/** Languages offered by the code-block language picker. */
export function codeLanguages(): string[] {
  return [...new Set([...LANGS, ...EXTRA_LANGS, ...Object.keys(ALIASES)])].sort();
}

setCodeHighlighter(highlightCode, prepareHighlighting);
setLiveCodeHighlighter(highlightCode);
// Warm the engine once the app is idle, so the first code block a user opens
// only waits for its grammar.
whenIdle(() => void loadCore(), 3000);
