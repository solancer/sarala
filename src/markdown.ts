import { Marked, Lexer, type Tokens } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/contrib/mhchem.mjs";
import { planEquation, type EquationPlan } from "./equations";
import { expandPhysics } from "./physics";
import { slugBase } from "./slug";
import { parseLegacyDiagram } from "./legacydiagrams";
import { emojiFor, emojiShortcode } from "./emoji";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Encode a string for safe use inside a double-quoted HTML attribute. */
const escapeAttr = (s: string) =>
  escapeHtml(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");

/* ---------- math preferences (gated, off by default) ---------- */

let mathAltDelimiters = false; // \( \) and \[ \]
let htmlEmbeds = false;
export function setHtmlEmbeds(on: boolean) { htmlEmbeds = on; }
let physicsEnabled = false;
export function setPhysicsEnabled(on: boolean) { physicsEnabled = on; }
let mathAutoNumber = false;
let equationCursor = 0;
let equationPlans: EquationPlan[] = [];
let equationLabels = new Map<string, string>();
export function setMathAutoNumber(on: boolean) { mathAutoNumber = on; }
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
let d2Stash: string[] = [];
let imgStash: string[] = [];
let shikiStash: string[] = [];
let mathErrored = false;

// Resolve a markdown image src to a loadable URL (relative→doc dir, Tauri
// asset protocol). Injected by images.ts; identity until then / in browser.
let imageResolver: (src: string) => string = (s) => s;
export function resolveMarkdownImage(src: string) { return imageResolver(src); }
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
  const plan = display ? equationPlans[equationCursor++] ?? planEquation(tex, 0, mathAutoNumber) : null;
  let t = plan?.tex ?? tex.trim();
  t = t.replace(/\\(eqref|ref)\{([^}]+)\}/g, (_, kind, name) => {
    const value = equationLabels.get(name) ?? "??";
    const label = kind === "eqref" ? `(${value})` : value;
    return equationLabels.has(name) ? `\\href{#eq-${encodeURIComponent(name)}}{${label}}` : label;
  });

  try {
    t = expandPhysics(t, 0, physicsEnabled);
    const html = katex.renderToString(t, {
      displayMode: display,
      throwOnError: true,
      strict: false,
      trust: context => context.command === "\\href" && !!context.url?.startsWith("#eq-"),

    });
    const anchors = plan ? [...plan.labels.keys()].map(label => `<span id="eq-${escapeAttr(label)}" class="equation-anchor"></span>`).join("") : "";
    return display ? `<div class="math-block">${anchors}${html}</div>` : html;
  } catch (e) {
    mathErrored = true;
    const msg = e instanceof Error ? e.message : String(e);
    const inner = `<span class="math-error" title="${escapeAttr(msg)}">${escapeHtml(t)}</span>`;
    return display ? `<div class="math-block math-block-error">${inner}</div>` : inner;
  }
}

function stashMath(tex: string, display: boolean, source?: string): string {
  const html = renderMathHtml(tex, display);
  mathStash.push(source && !display ? `<span data-math-source="${escapeAttr(source)}">${html}</span>` : html);
  const i = mathStash.length - 1;
  return display ? `<div data-math="${i}"></div>` : `<span data-math="${i}"></span>`;
}

const marked = new Marked({ gfm: true, breaks: false });
let footnoteCounts = new Map<string, number>();
let footnoteDescriptions = new Map<string, string>();

let referenceCacheSource = "";
let referenceCache = new Lexer().tokens.links;
let documentProvider: () => { id: number; text: string }[] = () => [];
export function setMarkdownDocumentProvider(provider: typeof documentProvider) { documentProvider = provider; }
export function inlineSourceTokens(source: string) {
  const lexer = new Lexer(marked.defaults);
  const docSource = documentProvider().map(b => b.text).join("\n\n");
  if (docSource !== referenceCacheSource) {
    referenceCacheSource = docSource;
    referenceCache = marked.lexer(docSource).links;
  }
  lexer.tokens.links = referenceCache;
  const tokens = lexer.inlineTokens(source);
  if (marked.defaults.walkTokens) marked.walkTokens(tokens, marked.defaults.walkTokens);
  return tokens;
}

marked.use({
  extensions: [
    {
      name: "footnoteDef", level: "block",
      start(src: string) { return src.match(/^ {0,3}\[\^[^\]\s]+\]:/m)?.index; },
      tokenizer(src: string) {
        const match = /^ {0,3}\[\^([^\]\s]+)\]:[ \t]*(.*)(?:\n|$)/.exec(src);
        if (!match) return undefined;
        let raw = match[0], body = match[2];
        const rest = src.slice(raw.length);
        const continuation = /^(?:(?:[ \t]*\n)*(?: {4}|\t)[^\n]*(?:\n|$))*/.exec(rest)![0];
        raw += continuation;
        if (continuation) body += "\n" + continuation.replace(/^(?: {4}|\t)/gm, "");
        return { type: "footnoteDef", raw, id: match[1], text: body, tokens: this.lexer.blockTokens(body) };
      },
      renderer(token) {
        const id = escapeAttr(String(token.id));
        const body = this.parser.parse(token.tokens as Tokens.Generic[]);
        return `<ol class="footnotes"><li class="footnote-def" id="fn-${id}">${body}<a class="footnote-backref" href="#fnref-${id}" aria-label="Back to reference">↩</a></li></ol>`;
      },
    },
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
        return stashMath((token as Tokens.Generic).text as string, false, token.raw);
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
        const m = emojiShortcode().exec(src);
        return m ? m.index : undefined;
      },
      tokenizer(src: string) {
        if (!emojiOn) return undefined;
        const m = emojiShortcode().exec(src);
        if (m?.index !== 0) return undefined;
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
        const n = footnoteCounts.get(id) ?? 0;
        footnoteCounts.set(id, n + 1);
        const description = footnoteDescriptions.get(String(token.text));
        const title = description ? ` title="${escapeAttr(description)}"` : "";
        return `<sup class="footnote-ref" id="fnref-${id}${n ? `-${n}` : ""}"><a href="#fn-${id}"${title} aria-label="Footnote ${label}">[${label}]</a></sup>`;
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
      const info = token.lang || "";
      const lang = info.split(/\s+/)[0].toLowerCase();
      if (lang === "sequence" || lang === "flow") {
        try {
          const diagram = parseLegacyDiagram(token.text, lang);
          mermaidStash.push(diagram.source);
          return `<div class="mermaid-block" data-${lang}="true" data-legacy-links="${escapeAttr(JSON.stringify(diagram.links))}" data-mmd="${mermaidStash.length - 1}"></div>`;
        } catch (error) {
          return `<pre><code>${escapeHtml(token.text)}</code></pre><p class="render-error">${escapeHtml(String(error))}</p>`;
        }
      }
      if (lang === "mermaid") {
        mermaidStash.push(token.text);
        return `<div class="mermaid-block" data-mmd="${mermaidStash.length - 1}"></div>`;
      }
      if (lang === "d2") {
        d2Stash.push(token.text);
        // Optional fence-info tokens, persisted in the markdown and baked into
        // exports: `zoom=NN` scales the diagram via CSS (NN%); `theme=NN` pins a
        // D2 theme id (renderD2In reads it off data-d2-theme). Clamp zoom so a
        // typo can't explode the layout.
        const z = Number(/(?:^|\s)zoom=(\d{1,3})\b/.exec(info)?.[1]);
        const style = z && z !== 100 ? ` style="zoom:${Math.min(400, Math.max(10, z))}%"` : "";
        const t = /(?:^|\s)theme=(\d{1,3})\b/.exec(info)?.[1];
        const themeAttr = t ? ` data-d2-theme="${t}"` : "";
        return `<div class="d2-block" data-d2idx="${d2Stash.length - 1}"${themeAttr}${style}></div>`;
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
  // fetchpriority/referrerpolicy are not in DOMPurify's default allowlist but
  // are inert loading hints the Image Properties panel can set; the rest of the
  // <img> attribute set (width/height/srcset/sizes/loading/decoding/crossorigin)
  // already survives by default.
  ADD_ATTR: ["target", "style", "controls", "open", "src", "type", "id", "fetchpriority", "referrerpolicy"],
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
  const root = document.createElement("template");
  root.innerHTML = html;
  for (const quote of Array.from(root.content.querySelectorAll("blockquote")).reverse()) {
    const first = quote.firstElementChild;
    if (first?.tagName !== "P") continue;
    const match = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*(?:<br\s*\/?>|\n)?/i.exec(first.innerHTML);
    if (!match) continue;
    const type = match[1].toLowerCase();
    first.innerHTML = first.innerHTML.slice(match[0].length);
    if (!first.innerHTML.trim()) first.remove();
    const alert = document.createElement("div");
    alert.className = `md-alert md-alert-${type}`;
    const title = document.createElement("p");
    title.className = "md-alert-title";
    title.textContent = ALERT_LABEL[type];
    alert.append(title, ...Array.from(quote.childNodes));
    quote.replaceWith(alert);
  }
  return root.innerHTML;
}

/* ---------- heading anchor ids ---------- */

const decodeEntities = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Give each rendered heading an anchor id matching the TOC's slug. */
function addHeadingIds(html: string, counts = new Map<string, number>()): string {
  return html.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_, lvl, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, "")).trim();
    const base = slugBase(text);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    return `<h${lvl} id="${escapeAttr(base + (n ? `-${n}` : ""))}">${inner}</h${lvl}>`;
  });
}

/**
 * Render a markdown string to sanitized HTML. `blockKey` (a block's stable id)
 * enables the last-good-on-math-error fallback for that block.
 */
// Inline placeholder for an image with no source yet (![]() ). Injected after
// sanitization, so its markers survive. Block.tsx wires the interactions:
// clicking the chip activates the block to type a URL; the Browse chip opens a
// file picker and fills the src.
const EMPTY_IMG_HINT =
  '<span class="img-empty" data-img-empty contenteditable="false">' +
  '<svg class="img-empty-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">' +
  '<rect x="3" y="3" width="18" height="18" rx="2.5"/><circle cx="8.5" cy="8.5" r="1.6"/><path d="m21 15-4.5-4.5L5 21"/></svg>' +
  '<span class="img-empty-label">Add an image — paste a URL, or</span>' +
  '<span class="img-empty-browse" data-img-browse role="button" tabindex="0">' +
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">' +
  '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>Browse…</span></span>';

export function renderMarkdown(md: string, blockKey?: string): string {
  if (!md.trim()) return `<p class="empty-block">&nbsp;</p>`;
  const trimmed = md.trim();
  const blocks = documentProvider();
  const blockIndex = blockKey == null ? -1 : blocks.findIndex(b => String(b.id) === blockKey);
  const whole = blockIndex >= 0 ? blocks.map(b => b.text).join("\n\n") : md;
  const allTokens = marked.lexer(whole);
  footnoteCounts = new Map();
  footnoteDescriptions = new Map();
  equationLabels = new Map();
  equationCursor = 0;
  equationPlans = [];
  let equationIndex = 0;
  marked.walkTokens(allTokens, token => {
    if (token.type === "blockMath" || (mathFence && token.type === "code" && token.lang === "math")) {
      const plan = planEquation(String(token.text ?? ""), equationIndex, mathAutoNumber);
      equationIndex = plan.nextNumber;
      equationPlans.push(plan);
      for (const [label, number] of plan.labels) {
        if (!equationLabels.has(label)) equationLabels.set(label, number);
        else plan.labels.delete(label);
      }

    }
  });
  marked.walkTokens(allTokens, token => {
    if (token.type === "footnoteDef") footnoteDescriptions.set(String(token.id), String(token.text));
  });
  const headingCounts = new Map<string, number>();
  if (blockIndex >= 0) {
    const prior = marked.lexer(blocks.slice(0, blockIndex).map(b => b.text).join("\n\n"));
    marked.walkTokens(prior, token => {
      if (token.type === "blockMath" || (mathFence && token.type === "code" && token.lang === "math")) equationCursor++;
      if (token.type === "footnoteRef") {
        const id = escapeAttr(String(token.text));
        footnoteCounts.set(id, (footnoteCounts.get(id) ?? 0) + 1);
      }
      if (token.type === "heading") {
        const base = slugBase(decodeEntities((marked.parseInline(token.text, { async: false }) as string).replace(/<[^>]+>/g, "")));
        headingCounts.set(base, (headingCounts.get(base) ?? 0) + 1);
      }
    });
  }
  const toc = () => {
    const headings = extractOutline(blockIndex >= 0 ? blocks.map(b => b.text) : [md]);
    const counts = new Map<string, number>();
    const items = (headings.length ? headings : tocProvider?.() ?? []).map(h => {
      const label = decodeEntities((marked.parseInline(h.text, {async:false}) as string).replace(/<[^>]+>/g, ""));
      const base = slugBase(label), n = counts.get(base) ?? 0;
      counts.set(base, n + 1);
      return `<li class="toc-l${h.level}"><a href="#${escapeAttr(base + (n ? `-${n}` : ""))}">${escapeHtml(label)}</a></li>`;
    }).join("");
    return `<ul class="toc">${items || "<li>No headings</li>"}</ul>`;
  };
  // YAML front matter. The live view boxes a `---\n…` block (Block.tsx isFence),
  // but marked would parse `---\n…\n---` as a thematic break + setext heading.
  // Render it as a metadata code box so the active and inactive views match.
  if (trimmed.startsWith("---\n") && /\n---$/.test(trimmed)) {
    return DOMPurify.sanitize(
      `<pre class="front-matter"><code>${escapeHtml(trimmed)}</code></pre>`,
      SANITIZE_OPTS,
    );
  }

  mathStash = [];
  mermaidStash = [];
  d2Stash = [];
  imgStash = [];
  shikiStash = [];
  mathErrored = false;
  // marked (CommonMark) rejects image destinations that contain spaces, so a
  // dropped path like `.../Screenshot from 2026.png` renders as literal text.
  // Wrap bare, unquoted image destinations containing whitespace in <> so they
  // parse. Skipped for fenced code blocks so markdown examples aren't rewritten.
  const isCodeFence = trimmed.startsWith("```") || trimmed.startsWith("~~~");
  const src = isCodeFence
    ? md
    : md.replace(/(!\[[^\]\n]*\]\()([^<>()"\n]*\s[^<>()"\n]*)(\))/g, "$1<$2>$3");
  const lexer = new Lexer(marked.defaults);
  lexer.tokens.links = allTokens.links;
  const tokens = lexer.lex(src);
  if (marked.defaults.walkTokens) marked.walkTokens(tokens, marked.defaults.walkTokens);
  marked.walkTokens(tokens, token => {
    if (token.type === "paragraph" && /^(?:\[TOC\]|\[\[_TOC_\]\])$/i.test(token.text.trim())) {
      const t = token as Tokens.Generic;
      t.type = "html"; t.text = toc(); t.tokens = undefined;
    }
  });
  let raw = transformAlerts(marked.parser(tokens, { ...marked.defaults, async: false }) as string)
    .replace(/<p>\s*(?:\[TOC\]|\[\[_TOC_\]\])\s*<\/p>/gi, toc);
  const embeds: string[] = [];
  if (htmlEmbeds) {
    const root = document.createElement("template"); root.innerHTML = raw;
    for (const frame of root.content.querySelectorAll("iframe")) {
      try {
        const url = new URL(frame.getAttribute("src") ?? "");
        if (url.protocol !== "https:" || url.username || url.password) { frame.remove(); continue; }
        const title = frame.getAttribute("title") || "Embedded content";
        embeds.push(`<iframe src="${escapeAttr(url.href)}" title="${escapeAttr(title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" loading="lazy"></iframe>`);
        const placeholder = document.createElement("div"); placeholder.dataset.embed = String(embeds.length - 1);
        frame.replaceWith(placeholder);
      } catch { frame.remove(); }
    }
    raw = root.innerHTML;
  }
  let html = addHeadingIds(DOMPurify.sanitize(raw, SANITIZE_OPTS), headingCounts)
    .replace(/<div data-embed="(\d+)"><\/div>/g, (_, i) => embeds[Number(i)] ?? "");
  // Re-inject the KaTeX markup the sanitizer left as empty placeholders, swap
  // each mermaid placeholder's numeric key for its real source (DOMPurify
  // strips it for containing "-->"), and the resolved image src (which may use
  // an asset-protocol scheme the sanitizer would otherwise drop).
  html = html
    .replace(/<span data-math="(\d+)">\s*<\/span>/g, (_, i) => mathStash[Number(i)] ?? "")
    .replace(/<div data-math="(\d+)">\s*<\/div>/g, (_, i) => mathStash[Number(i)] ?? "")
    .replace(/data-mmd="(\d+)"/g, (_, i) => `data-mermaid="${escapeAttr(mermaidStash[Number(i)] ?? "")}"`)
    .replace(/data-d2idx="(\d+)"/g, (_, i) => `data-d2="${escapeAttr(d2Stash[Number(i)] ?? "")}"`)
    .replace(/data-img="(\d+)"/g, (_, i) => `src="${escapeAttr(imgStash[Number(i)] ?? "")}"`)
    .replace(/<div data-shiki="(\d+)">\s*<\/div>/g, (_, i) => shikiStash[Number(i)] ?? "");
  // Resolve srcs of raw HTML <img> tags (markdown images were already handled
  // above; their resolved asset URLs pass the resolver through unchanged).
  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const m = /\ssrc\s*=\s*"([^"]*)"/i.exec(tag);
    // An image with no source yet → an inline hint to type a URL or browse.
    if (!m || !m[1].trim()) return EMPTY_IMG_HINT;
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
  const normalized = md.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  // Blank lines inside a loose list belong to that list. Splitting there
  // restarts ordered numbering and detaches indented continuation paragraphs.
  const listInterior = new Set<number>();
  let tokenLine = 0;
  for (const token of marked.lexer(normalized)) {
    if (["list", "code", "blockquote", "html", "blockMath", "footnoteDef"].includes(token.type)) {
      const contentLines = token.raw.trimEnd().split("\n").length;
      for (let n = 1; n < contentLines; n++) listInterior.add(tokenLine + n);
    }
    tokenLine += (token.raw.match(/\n/g) ?? []).length;
  }
  // HTML containers may contain Markdown and blank lines. Keep their full
  // extent together while leaving fences and ordinary HTML parsing untouched.
  let detailsDepth = 0;
  lines.forEach((line, index) => {
    const opening = (line.match(/<details(?:\s[^>]*)?>/gi) ?? []).length;
    if (detailsDepth > 0 || opening) listInterior.add(index);
    detailsDepth += opening - (line.match(/<\/details\s*>/gi) ?? []).length;
    detailsDepth = Math.max(0, detailsDepth);
  });
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  let fenceMark = "";
  let fenceLength = 0;
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
        fenceLength = fence[2].length;
      } else if (fence[2][0] === fenceMark && fence[2].length >= fenceLength && /^\s*$/.test(line.slice(fence[0].length))) {
        inFence = false;
      }
      buf.push(line);
      continue;
    }
    if (!inFence && !listInterior.has(i) && line.trim() === "") {
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
  let length = 0;
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (!m) continue;
    if (!open) {
      open = true;
      mark = m[1][0];
      length = m[1].length;
    } else if (m[1][0] === mark && m[1].length >= length && /^\s*$/.test(line.slice(m[0].length))) {
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
    for (const token of marked.lexer(b)) {
      if (token.type === "heading") out.push({ level: token.depth, text: token.text, blockIndex });
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
  const candidates: number[] = [];
  const walk = (source: string, offsets: number[]) => {
    let cursor = 0;
    for (const token of marked.lexer(source)) {
      const at = source.indexOf(token.raw, cursor);
      if (at < 0) continue;
      cursor = at + token.raw.length;
      if (token.type === "blockquote") {
        let normalized = ""; const mapped: number[] = [];
        let pos = at;
        for (const line of token.raw.split(/(?<=\n)/)) {
          const prefix = /^ {0,3}>[ \t]?/.exec(line)?.[0].length ?? 0;
          normalized += line.slice(prefix);
          mapped.push(...offsets.slice(pos + prefix, pos + line.length));
          pos += line.length;
        }
        walk(normalized, mapped);
      }
      if (token.type !== "list") continue;
      let itemAt = at;
      for (const item of (token as Tokens.List).items) {
        const pos = source.indexOf(item.raw, itemAt);
        if (pos < 0) continue;
        itemAt = pos + item.raw.length;
        const prefix = /^[ \t]*(?:[-+*]|\d+[.)])(?:[ \t]+|$)/.exec(item.raw);
        if (!prefix) continue;
        let skip = prefix[0].length;
        if (item.task) {
          const marker = /^\[[ xX]\][ \t]*/.exec(item.raw.slice(skip));
          if (marker) { candidates.push(offsets[pos + skip]); skip += marker[0].length; }
        }
        let normalized = ""; const mapped: number[] = [];
        let lineAt = pos;
        item.raw.split(/(?<=\n)/).forEach((line, index) => {
          const trim = index === 0 ? skip : Math.min(prefix[0].length, /^[ \t]*/.exec(line)![0].length);
          normalized += line.slice(trim);
          mapped.push(...offsets.slice(lineAt + trim, lineAt + line.length));
          lineAt += line.length;
        });
        walk(normalized, mapped);
      }
    }
  };
  walk(text, Array.from({length: text.length}, (_, i) => i));
  const at = [...new Set(candidates)].sort((a,b) => a-b)[nth];
  if (at === undefined) return text;
  return text.slice(0, at + 1) + (text[at + 1] === " " ? "x" : " ") + text.slice(at + 2);
}
