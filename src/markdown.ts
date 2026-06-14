import { Marked, type Tokens } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import { slugBase } from "./slug";
import { emojiFor } from "./emoji";

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

/* ---------- inline-syntax preferences ---------- */

let emojiOn = true; //  :smile:  shortcodes
let highlightOn = true; //  ==text==
let subSupOn = true; //  ~sub~  ^sup^
let autolinkOn = true; // bare URLs
export function setEmojiEnabled(on: boolean) {
  emojiOn = on;
}
export function setHighlightEnabled(on: boolean) {
  highlightOn = on;
}
export function setSubSupEnabled(on: boolean) {
  subSupOn = on;
}
export function setAutolinkEnabled(on: boolean) {
  autolinkOn = on;
}

/* ---------- KaTeX rendering ---------- */

// Per-render scratch: math HTML and mermaid source are stashed and re-injected
// after DOMPurify (KaTeX markup and Mermaid's "-->" arrows both trip the
// sanitizer otherwise — the latter reads as a comment-close mXSS vector).
let mathStash: string[] = [];
let mermaidStash: string[] = [];
let imgStash: string[] = [];
let shikiStash: string[] = [];
let mathErrored = false;

// Resolve a markdown image src to a loadable URL (relative→doc dir, Tauri
// asset protocol). Injected by images.ts; identity until then / in browser.
let imageResolver: (src: string) => string = (s) => s;
export function setImageResolver(fn: (src: string) => string) {
  imageResolver = fn;
}

// Syntax-highlight a code block to HTML (Shiki). Injected by highlighter.ts;
// returns null until Shiki has loaded, falling back to plain escaped code.
let codeHighlighter: (code: string, lang: string) => string | null = () => null;
export function setCodeHighlighter(fn: (code: string, lang: string) => string | null) {
  codeHighlighter = fn;
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
    {
      // ==highlight== → <mark>. Inner text is inline-parsed so emphasis etc.
      // still works inside a highlight.
      name: "highlight",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("==");
        return i === -1 ? undefined : i;
      },
      tokenizer(src: string) {
        if (!highlightOn) return undefined;
        const m = /^==(?=\S)([\s\S]*?\S)==/.exec(src);
        if (!m) return undefined;
        const token = { type: "highlight", raw: m[0], text: m[1], tokens: [] as Tokens.Generic[] };
        this.lexer.inline(m[1], token.tokens);
        return token;
      },
      renderer(token) {
        return `<mark>${this.parser.parseInline((token as Tokens.Generic).tokens ?? [])}</mark>`;
      },
    },
    {
      // ~subscript~ — a single tilde, never the GFM ~~strikethrough~~ (the
      // lookahead rejects a second tilde, leaving strikethrough to GFM).
      name: "subscript",
      level: "inline",
      start(src: string) {
        const m = /(?<!~)~(?![~\s])[^~\n]+?~(?!~)/.exec(src);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        if (!subSupOn) return undefined;
        const m = /^~(?![~\s])([^~\n]+?)~(?!~)/.exec(src);
        if (!m) return undefined;
        const token = { type: "subscript", raw: m[0], text: m[1], tokens: [] as Tokens.Generic[] };
        this.lexer.inline(m[1], token.tokens);
        return token;
      },
      renderer(token) {
        return `<sub>${this.parser.parseInline((token as Tokens.Generic).tokens ?? [])}</sub>`;
      },
    },
    {
      // ^superscript^ — no whitespace inside (matches CommonMark-extension
      // convention; spaces would need backslash-escaping).
      name: "superscript",
      level: "inline",
      start(src: string) {
        const m = /\^(?!\s)[^\^\s]+?\^/.exec(src);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        if (!subSupOn) return undefined;
        const m = /^\^(?!\s)([^\^\s]+?)\^/.exec(src);
        if (!m) return undefined;
        const token = { type: "superscript", raw: m[0], text: m[1], tokens: [] as Tokens.Generic[] };
        this.lexer.inline(m[1], token.tokens);
        return token;
      },
      renderer(token) {
        return `<sup>${this.parser.parseInline((token as Tokens.Generic).tokens ?? [])}</sup>`;
      },
    },
    {
      // \: escapes the emoji colon so a literal ":word:" can be written.
      name: "emojiEscape",
      level: "inline",
      start(src: string) {
        const i = src.indexOf("\\:");
        return i === -1 ? undefined : i;
      },
      tokenizer(src: string) {
        const m = /^\\:/.exec(src);
        if (!m) return undefined;
        return { type: "emojiEscape", raw: m[0], text: ":" };
      },
      renderer() {
        return ":";
      },
    },
    {
      // :shortcode: → glyph. Unknown shortcodes are left as literal text so a
      // stray colon-word doesn't disappear.
      name: "emoji",
      level: "inline",
      // Only fire on a complete :shortcode: — a bare ":" (e.g. inside an
      // "https://" URL) must not cut the text run, or autolinking breaks.
      start(src: string) {
        const m = /:[a-z0-9_+-]+:/.exec(src);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        if (!emojiOn) return undefined;
        const m = /^:([a-z0-9_+-]+):/.exec(src);
        if (!m) return undefined;
        const glyph = emojiFor(m[1]);
        if (!glyph) return undefined;
        return { type: "emoji", raw: m[0], text: glyph };
      },
      renderer(token) {
        return `<span class="emoji">${escapeHtml((token as Tokens.Generic).text as string)}</span>`;
      },
    },
    {
      // [^id] footnote reference (not a [^id]: definition — those are handled as
      // whole blocks in renderMarkdown). Cross-block numbering/jump is deferred;
      // the label shown is the literal id.
      name: "footnoteRef",
      level: "inline",
      start(src: string) {
        const m = /\[\^[^\]\s]+\](?!:)/.exec(src);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        const m = /^\[\^([^\]\s]+)\](?!:)/.exec(src);
        if (!m) return undefined;
        return { type: "footnoteRef", raw: m[0], text: m[1] };
      },
      renderer(token) {
        const id = escapeAttr((token as Tokens.Generic).text as string);
        const label = escapeHtml((token as Tokens.Generic).text as string);
        return `<sup class="footnote-ref" id="fnref-${id}"><a href="#fn-${id}">[${label}]</a></sup>`;
      },
    },
  ],
  renderer: {
    // Drop marked's default `disabled` on task-list checkboxes. A disabled
    // input fires no click events, so the click would fall through to the
    // block-activate path instead of toggling. Block.tsx's onRenderedClick
    // owns the toggle (preventDefault + rewrite source), so the box is never
    // edited natively.
    checkbox(token: Tokens.Checkbox) {
      return `<input type="checkbox"${token.checked ? " checked" : ""}>`;
    },
    // Own the code renderer so ```mermaid and ```math fences are intercepted;
    // everything else is Shiki-highlighted (stashed past DOMPurify, which would
    // strip Shiki's inline-style color spans), with a plain fallback until
    // Shiki has loaded.
    code(token: Tokens.Code) {
      const lang = (token.lang || "").split(/\s+/)[0].toLowerCase();
      if (lang === "mermaid") {
        mermaidStash.push(token.text);
        return `<div class="mermaid-block" data-mmd="${mermaidStash.length - 1}"></div>`;
      }
      if (lang === "math" && mathFence) {
        return stashMath(token.text, true);
      }
      const hl = codeHighlighter(token.text, lang);
      if (hl) {
        shikiStash.push(hl);
        return `<div data-shiki="${shikiStash.length - 1}"></div>`;
      }
      return `<pre class="code-plain"><code${lang ? ` class="language-${lang}"` : ""}>${escapeHtml(token.text)}</code></pre>`;
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

// When bare-URL autolinking is disabled, demote GFM autolink tokens (whose raw
// equals their text — no [label](url) brackets) back to plain text.
marked.use({
  walkTokens(token) {
    if (autolinkOn) return;
    if (
      token.type === "link" &&
      token.raw === token.text &&
      /^(https?:\/\/|www\.|mailto:)/i.test(token.raw)
    ) {
      const t = token as Tokens.Generic;
      t.type = "text";
      t.tokens = undefined;
    }
  },
});

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

// Expanded allowlist: keep the placeholder data-* attrs (default-allowed) and
// admit the extra inline tags/attributes the sweep introduces.
const SANITIZE_OPTS = {
  ADD_TAGS: ["kbd", "ruby", "rt", "rp", "details", "summary", "video", "source", "u", "mark", "sub", "sup"],
  ADD_ATTR: ["target", "style", "controls", "open", "src", "type", "id"],
};

/* ---------- GitHub-style alerts ---------- */

const ALERT_LABEL: Record<string, string> = {
  note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution",
};

/**
 * Convert a blockquote whose first line is `[!NOTE]` (etc.) into a styled alert
 * callout. Runs on the raw HTML before DOMPurify; `div`/`p`/`class` all survive
 * sanitization. Non-greedy match handles only flat (non-nested) blockquotes,
 * which is all the alert syntax produces.
 */
function transformAlerts(html: string): string {
  return html.replace(/<blockquote>([\s\S]*?)<\/blockquote>/g, (full, inner: string) => {
    const m = /^\s*<p>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>|\n)?/i.exec(inner);
    if (!m) return full;
    const type = m[1].toLowerCase();
    const body = inner.replace(m[0], "<p>").replace(/^\s*<p>\s*<\/p>\s*/, "");
    return (
      `<div class="md-alert md-alert-${type}">` +
      `<p class="md-alert-title">${ALERT_LABEL[type]}</p>${body}</div>`
    );
  });
}

/* ---------- heading anchor ids ---------- */

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Give each rendered heading an anchor id matching the TOC's slug. */
function addHeadingIds(html: string): string {
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, lvl, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    return `<h${lvl} id="${escapeAttr(slugBase(text))}">${inner}</h${lvl}>`;
  });
}

/* ---------- footnote definition blocks ---------- */

const FOOTNOTE_DEF = /^\[\^([^\]\s]+)\]:\s?(.*)$/;

/** True if every non-blank line of the block is a `[^id]: text` definition. */
function isFootnoteDefBlock(md: string): boolean {
  const lines = md.split("\n").filter((l) => l.trim());
  return lines.length > 0 && lines.every((l) => FOOTNOTE_DEF.test(l));
}

/** Render a footnote-definition block as a linked footnotes section. */
function renderFootnoteDefs(md: string): string {
  const items = md
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const m = FOOTNOTE_DEF.exec(line)!;
      const id = escapeAttr(m[1]);
      const label = escapeHtml(m[1]);
      const text = marked.parseInline(m[2], { async: false }) as string;
      return (
        `<li class="footnote-def" id="fn-${id}">` +
        `<span class="footnote-label">${label}.</span> ${text} ` +
        `<a href="#fnref-${id}" class="footnote-backref" title="Back to reference">↩</a></li>`
      );
    })
    .join("");
  return DOMPurify.sanitize(`<ol class="footnotes">${items}</ol>`, SANITIZE_OPTS);
}

/**
 * Render a markdown string to sanitized HTML. `blockKey` (a block's stable id)
 * enables the last-good-on-math-error fallback for that block.
 */
export function renderMarkdown(md: string, blockKey?: string): string {
  if (!md.trim()) return `<p class="empty-block">&nbsp;</p>`;
  const trimmed = md.trim();
  // A lone [TOC] / [[_TOC_]] paragraph renders as the document outline, each
  // entry linking to its heading's slug anchor.
  if ((trimmed === "[TOC]" || trimmed === "[[_TOC_]]") && tocProvider) {
    const items = tocProvider()
      .map(
        (h) =>
          `<li class="toc-l${h.level}"><a href="#${escapeAttr(slugBase(h.text))}">${escapeHtml(h.text)}</a></li>`,
      )
      .join("");
    return DOMPurify.sanitize(`<ul class="toc">${items || "<li>No headings</li>"}</ul>`, SANITIZE_OPTS);
  }
  // A block of only `[^id]: text` lines renders as the footnotes section.
  if (isFootnoteDefBlock(md)) return renderFootnoteDefs(md);

  mathStash = [];
  mermaidStash = [];
  imgStash = [];
  shikiStash = [];
  mathErrored = false;
  const raw = transformAlerts(marked.parse(md, { async: false }) as string);
  let html = addHeadingIds(DOMPurify.sanitize(raw, SANITIZE_OPTS));
  // Re-inject the KaTeX markup the sanitizer left as empty placeholders, swap
  // each mermaid placeholder's numeric key for its real source (DOMPurify
  // strips it for containing "-->"), and the resolved image src (which may use
  // an asset-protocol scheme the sanitizer would otherwise drop).
  html = html
    .replace(/<span data-math="(\d+)">\s*<\/span>/g, (_, i) => mathStash[Number(i)] ?? "")
    .replace(/<div data-math="(\d+)">\s*<\/div>/g, (_, i) => mathStash[Number(i)] ?? "")
    .replace(/data-mmd="(\d+)"/g, (_, i) => `data-mermaid="${escapeAttr(mermaidStash[Number(i)] ?? "")}"`)
    .replace(/data-img="(\d+)"/g, (_, i) => `src="${escapeAttr(imgStash[Number(i)] ?? "")}"`)
    .replace(/<div data-shiki="(\d+)">\s*<\/div>/g, (_, i) => shikiStash[Number(i)] ?? "");
  // Resolve srcs of raw HTML <img> tags (markdown images were already handled
  // above; their resolved asset URLs pass the resolver through unchanged).
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\ssrc\s*=\s*"([^"]*)"/i.exec(tag);
    if (!m) return tag;
    const resolved = imageResolver(m[1]);
    return resolved === m[1] ? tag : tag.replace(m[0], ` src="${escapeAttr(resolved)}"`);
  });

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
