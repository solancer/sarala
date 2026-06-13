import { Marked, type Tokens } from "marked";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";
import katex from "katex";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Encode a string for safe use inside a double-quoted HTML attribute. */
const escapeAttr = (s: string) =>
  escapeHtml(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");

/* ---------- math preferences (gated, off by default) ---------- */

let mathAltDelimiters = false; // \( \) and \[ \]
let mathFence = false; //  ```math  fenced block
export function setMathAltDelimiters(on: boolean) {
  mathAltDelimiters = on;
}
export function setMathFence(on: boolean) {
  mathFence = on;
}

/* ---------- KaTeX rendering ---------- */

// Per-render scratch: math HTML and mermaid source are stashed and re-injected
// after DOMPurify (KaTeX markup and Mermaid's "-->" arrows both trip the
// sanitizer otherwise — the latter reads as a comment-close mXSS vector).
let mathStash: string[] = [];
let mermaidStash: string[] = [];
let imgStash: string[] = [];
let mathErrored = false;

// Resolve a markdown image src to a loadable URL (relative→doc dir, Tauri
// asset protocol). Injected by images.ts; identity until then / in browser.
let imageResolver: (src: string) => string = (s) => s;
export function setImageResolver(fn: (src: string) => string) {
  imageResolver = fn;
}

function renderMathHtml(tex: string, display: boolean): string {
  const t = tex.trim();
  try {
    const html = katex.renderToString(t, {
      displayMode: display,
      throwOnError: true,
      strict: false,
    });
    return display ? `<div class="math-block">${html}</div>` : html;
  } catch (e) {
    mathErrored = true;
    const msg = e instanceof Error ? e.message : String(e);
    const inner = `<span class="math-error" title="${escapeAttr(msg)}">${escapeHtml(t)}</span>`;
    return display ? `<div class="math-block math-block-error">${inner}</div>` : inner;
  }
}

function stashMath(tex: string, display: boolean): string {
  mathStash.push(renderMathHtml(tex, display));
  const i = mathStash.length - 1;
  return display ? `<div data-math="${i}"></div>` : `<span data-math="${i}"></span>`;
}

const marked = new Marked({ gfm: true, breaks: false });

marked.use({
  extensions: [
    {
      name: "inlineMath",
      level: "inline",
      start(src: string) {
        const m = src.match(/\$|\\\(/);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        // $...$ — guarded against currency ("$5 and $10"): no space just
        // inside the delimiters, closing $ not followed by a digit.
        let m = /^\$(?!\s)((?:\\.|[^$\n])*?[^\s\\])\$(?!\d)/.exec(src);
        if (!m) m = /^\$(?!\s)(\S)\$(?!\d)/.exec(src); // single-char case
        if (m) return { type: "inlineMath", raw: m[0], text: m[1] };
        if (mathAltDelimiters) {
          const a = /^\\\(([\s\S]+?)\\\)/.exec(src);
          if (a) return { type: "inlineMath", raw: a[0], text: a[1] };
        }
        return undefined;
      },
      renderer(token) {
        return stashMath((token as Tokens.Generic).text as string, false);
      },
    },
    {
      name: "blockMath",
      level: "block",
      start(src: string) {
        const m = src.match(/\$\$|\\\[/);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        let m = /^\$\$([\s\S]+?)\$\$/.exec(src);
        if (m) return { type: "blockMath", raw: m[0], text: m[1] };
        if (mathAltDelimiters) {
          m = /^\\\[([\s\S]+?)\\\]/.exec(src);
          if (m) return { type: "blockMath", raw: m[0], text: m[1] };
        }
        return undefined;
      },
      renderer(token) {
        return stashMath((token as Tokens.Generic).text as string, true);
      },
    },
  ],
  renderer: {
    // Own the code renderer (replacing marked-highlight) so ```mermaid and
    // ```math fences are intercepted; everything else is hljs-highlighted.
    code(token: Tokens.Code) {
      const lang = (token.lang || "").split(/\s+/)[0].toLowerCase();
      if (lang === "mermaid") {
        mermaidStash.push(token.text);
        return `<div class="mermaid-block" data-mmd="${mermaidStash.length - 1}"></div>`;
      }
      if (lang === "math" && mathFence) {
        return stashMath(token.text, true);
      }
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      const html = hljs.highlight(token.text, { language }).value;
      return `<pre><code class="hljs${lang ? ` language-${lang}` : ""}">${html}</code></pre>`;
    },
    // Resolve the src through the injected resolver and stash it, so the
    // (possibly asset-protocol) URL is re-injected after DOMPurify.
    image(token: Tokens.Image) {
      imgStash.push(imageResolver(token.href || ""));
      const i = imgStash.length - 1;
      const alt = escapeAttr(token.text || "");
      const title = token.title ? ` title="${escapeAttr(token.title)}"` : "";
      return `<img data-img="${i}" alt="${alt}"${title}>`;
    },
  },
});

/** Languages the bundled highlighter knows, for the code-block picker. */
export function listCodeLanguages(): string[] {
  return hljs.listLanguages().sort();
}

/** Edit ▸ Whitespace: render single newlines as <br> when enabled. */
export function setPreserveBreaksOption(on: boolean) {
  marked.setOptions({ breaks: on });
}

// Injected by the store (markdown.ts cannot import store — circular).
let tocProvider: (() => Heading[]) | null = null;
export function setTocProvider(fn: () => Heading[]) {
  tocProvider = fn;
}

// Last good rendered HTML per block, so a block whose math breaks mid-edit
// shows its previous render plus an error rather than blanking.
const lastGoodBlock = new Map<string, string>();

/**
 * Render a markdown string to sanitized HTML. `blockKey` (a block's stable id)
 * enables the last-good-on-math-error fallback for that block.
 */
export function renderMarkdown(md: string, blockKey?: string): string {
  if (!md.trim()) return `<p class="empty-block">&nbsp;</p>`;
  // A lone [TOC] paragraph renders as the document outline.
  if (md.trim() === "[TOC]" && tocProvider) {
    const items = tocProvider()
      .map((h) => `<li class="toc-l${h.level}">${escapeHtml(h.text)}</li>`)
      .join("");
    return DOMPurify.sanitize(`<ul class="toc">${items || "<li>No headings</li>"}</ul>`);
  }

  mathStash = [];
  mermaidStash = [];
  imgStash = [];
  mathErrored = false;
  const raw = marked.parse(md, { async: false }) as string;
  let html = DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
  // Re-inject the KaTeX markup the sanitizer left as empty placeholders, swap
  // each mermaid placeholder's numeric key for its real source (DOMPurify
  // strips it for containing "-->"), and the resolved image src (which may use
  // an asset-protocol scheme the sanitizer would otherwise drop).
  html = html
    .replace(/<span data-math="(\d+)">\s*<\/span>/g, (_, i) => mathStash[Number(i)] ?? "")
    .replace(/<div data-math="(\d+)">\s*<\/div>/g, (_, i) => mathStash[Number(i)] ?? "")
    .replace(/data-mmd="(\d+)"/g, (_, i) => `data-mermaid="${escapeAttr(mermaidStash[Number(i)] ?? "")}"`)
    .replace(/data-img="(\d+)"/g, (_, i) => `src="${escapeAttr(imgStash[Number(i)] ?? "")}"`);

  if (blockKey != null) {
    const hasMath = mathStash.length > 0;
    if (mathErrored && lastGoodBlock.has(blockKey)) {
      return `${lastGoodBlock.get(blockKey)}<div class="render-error">⚠ Math error — showing last valid render</div>`;
    }
    if (hasMath && !mathErrored) lastGoodBlock.set(blockKey, html);
  }
  return html;
}

/**
 * Split a markdown document into editable blocks.
 * Blocks are separated by blank lines, but fenced code blocks and
 * leading YAML front matter are kept intact as single blocks.
 */
export function splitBlocks(md: string): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  let fenceMark = "";
  let i = 0;

  // YAML front matter
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (end > 0) {
      blocks.push(lines.slice(0, end + 1).join("\n"));
      i = end + 1;
      while (i < lines.length && lines[i].trim() === "") i++;
    }
  }

  const flush = () => {
    if (buf.length) blocks.push(buf.join("\n"));
    buf = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[2][0];
      } else if (fence[2][0] === fenceMark) {
        inFence = false;
      }
      buf.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks.length ? blocks : [""];
}

/** Detect whether a block's text still contains an unterminated fence. */
export function hasOpenFence(text: string): boolean {
  let open = false;
  let mark = "";
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (!m) continue;
    if (!open) {
      open = true;
      mark = m[1][0];
    } else if (m[1][0] === mark) {
      open = false;
    }
  }
  return open;
}

export function joinBlocks(blocks: string[]): string {
  return blocks.join("\n\n") + "\n";
}

export interface Heading {
  level: number;
  text: string;
  blockIndex: number;
}

export function extractOutline(blocks: string[]): Heading[] {
  const out: Heading[] = [];
  blocks.forEach((b, blockIndex) => {
    if (hasOpenFence(b)) return;
    let inFence = false;
    for (const line of b.split("\n")) {
      if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
      if (inFence) continue;
      const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) out.push({ level: m[1].length, text: m[2], blockIndex });
    }
  });
  return out;
}

export function countWords(md: string): { words: number; chars: number } {
  const stripped = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\-\[\]()!|]/g, " ")
    .trim();
  const words = stripped ? stripped.split(/\s+/).length : 0;
  return { words, chars: md.length };
}

/** Toggle the nth task-list checkbox inside a block's source. */
export function toggleTask(text: string, nth: number): string {
  let seen = -1;
  return text.replace(/\[( |x|X)\]/g, (m, state) => {
    seen++;
    if (seen !== nth) return m;
    return state === " " ? "[x]" : "[ ]";
  });
}
