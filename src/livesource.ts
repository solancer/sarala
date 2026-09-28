import { emojiFor, emojiShortcode } from "./emoji";
import { inlineSourceTokens, resolveMarkdownImage } from "./markdown";
import { splitPipeRow } from "./tabletools";
import { Lexer, Marked, type Token, type Tokens } from "marked";

/**
 * Live-styled Markdown source — WYSIWYG inline editing.
 * The active block shows its raw source, but markers are dimmed and
 * content is styled in real time as you type. Rendering to final HTML
 * happens only when the caret leaves the block (Enter / blur / Esc).
 */



// Mirror the renderer's inline-syntax prefs so the active block styles only
// what will actually render. textContent stays byte-identical either way \u2014
// these only gate visual styling, never alter source text.
let liveHighlight = true;
let liveSubSup = true;
export function setLiveHighlight(on: boolean) { liveHighlight = on; }
export function setLiveSubSup(on: boolean) { liveSubSup = on; }

// Inject the same Shiki renderer used by preview without importing its async
// loader (which depends on the document store).
let liveCodeHighlighter: (code: string, lang: string) => string | null = () => null;
export function setLiveCodeHighlighter(highlight: typeof liveCodeHighlighter) {
  liveCodeHighlighter = highlight;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const mark = (s: string) => `<span class="md-mark">${s}</span>`;

/**
 * Caret-scoped reveal container: markers inside a .md-tok are hidden by CSS
 * unless the token carries .md-on (toggled by applyMarkerVisibility based on
 * the caret position). Hiding is CSS-only (display:none) so textContent stays
 * byte-identical to the source — the caret-offset invariant.
 */
const tok = (html: string) => `<span class="md-tok">${html}</span>`;

/** Parse the original source with preview's grammar, retaining every source byte. */
function inline(text: string): string {
  const raw = text.replace(/&(?:amp|lt|gt);/g, entity => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity]!);
  const attr = (s: string) => esc(s).replace(/"/g, "&quot;").replace(/\n/g, "&#10;");
  const generated = (source: string, value: string) => tok(`${mark(esc(source))}<span class="md-generated" data-visible="${attr(value)}"></span>`);
  const render = (tokens: Token[]): string => tokens.map((token, index) => {
    // Pair underline tags so both delimiters share a caret-scoped token.
    if (token.type === "html" && /^<u>$/i.test(token.raw)) {
      const end = tokens.findIndex((t, i) => i > index && t.type === "html" && /^<\/u>$/i.test(t.raw));
      if (end > index) {
        const body = tokens.splice(index + 1, end - index);
        const close = body.pop()!;
        return tok(`${mark(esc(token.raw))}<u>${render(body)}</u>${mark(esc(close.raw))}`);
      }
    }
    const t = token as Tokens.Generic;
    const raw = token.raw;
    if (["strong", "em", "del", "highlight", "subscript", "superscript"].includes(token.type)) {
      const tags: Record<string, string> = { strong: "strong", em: "em", del: "del", highlight: "mark", subscript: "sub", superscript: "sup" };
      if ((token.type === "highlight" && !liveHighlight) || (["subscript", "superscript"].includes(token.type) && !liveSubSup)) return esc(raw);
      const width = ["strong", "del", "highlight"].includes(token.type) ? 2 : 1;
      const body = raw.slice(width, -width);
      return tok(`${mark(esc(raw.slice(0, width)))}<${tags[token.type]}>${render(inlineSourceTokens(body))}</${tags[token.type]}>${mark(esc(raw.slice(-width)))}`);
    }
    if (token.type === "escape") return tok(`${mark(esc(raw[0]))}${esc(raw.slice(1))}`);
    if (token.type === "codespan") {
      const fence = raw.match(/^`+/)![0];
      let body = raw.slice(fence.length, -fence.length);
      let left = "", right = "";
      if (/^ [\s\S]* $/.test(body) && /[^ ]/.test(body)) { left = " "; right = " "; body = body.slice(1,-1); }
      return tok(`${mark(fence + left)}<span class="md-codespan">${esc(body)}</span>${mark(right + fence)}`);
    }
    if (token.type === "link") {
      if (raw.startsWith("[")) {
        const label = (t.tokens as Token[] ?? []).map(t => t.raw).join("");
        return tok(`${mark("[")}<span class="md-link">${render(t.tokens as Token[] ?? [])}</span><span class="md-mark md-url">${esc(raw.slice(1 + label.length))}</span>`);
      }
      if (raw.startsWith("<")) return tok(`${mark("&lt;")}<span class="md-link">${esc(raw.slice(1,-1))}</span>${mark("&gt;")}`);
      return `<span class="md-link">${esc(raw)}</span>`;
    }
    if (token.type === "inlineMath") return tok(`${mark(esc(raw))}<span class="md-inline-preview" data-markdown="${attr(raw)}" contenteditable="false"></span>`);
    if (token.type === "footnoteRef") return tok(`${mark(esc(raw))}<sup class="footnote-ref md-generated" data-visible="[${attr(String(t.text))}]" aria-label="Footnote ${attr(String(t.text))}"></sup>`);
    if (token.type === "image") {
      const href = resolveMarkdownImage(String(t.href ?? ""));
      const title = t.title ? ` title="${attr(String(t.title))}"` : "";
      if (/^(?:javascript|data):/i.test(href)) return esc(raw);
      return tok(`${mark(esc(raw))}<img src="${attr(href)}" alt="${attr(String(t.text ?? ""))}" contenteditable="false"${title}>`);
    }
    if (token.type === "br") return `${tok(mark(esc(raw.slice(0,-1))))}<span class="md-hard-break">\n</span>`;
    if (token.type === "html") {
      const tag = /^<\/?(u|kbd|mark|sub|sup|span|ruby|rt|rp|b|i|strong|em|s|del)(?:\s[^>]*)?>$/i.exec(raw);
      if (tag) {
        let style = "";
        if (!raw.startsWith("</")) {
          const element = document.createElement("template"); element.innerHTML = raw;
          const node = element.content.firstElementChild as HTMLElement | null;
          for (const property of ["color", "background-color", "font-weight", "font-style", "text-decoration"]) {
            const value = node?.style.getPropertyValue(property);
            if (value && !/url\s*\(/i.test(value)) style += `${property}:${value};`;
          }
        }
        return tok(mark(esc(raw))) + `<${raw.startsWith("</") ? "/" : ""}${tag[1].toLowerCase()}${style ? ` style="${attr(style)}"` : ""}>`;
      }
      if (/^<br\s*\/?>$/i.test(raw)) return tok(mark(esc(raw))) + "<br>";
      if (raw.startsWith("<!--")) return tok(mark(esc(raw)));
      return esc(raw);
    }
    if (token.type === "emoji") return generated(raw, String(t.emoji ?? t.text ?? raw));
    if (token.type === "text") {
      if (t.tokens) return render(t.tokens as Token[]);
      return esc(raw).replace(/&amp;((?:#\d+|#x[\da-f]+|[a-z][a-z0-9]+);)/gi, (_, entity: string) => {
        const el = document.createElement("textarea"); el.innerHTML = "&" + entity;
        return generated("&" + entity, el.value);
      });
    }
    return esc(raw);
  }).join("");
  return render(inlineSourceTokens(raw));
}

/** Style one escaped line with its block-level construct. */
function styleLine(raw: string): string {
  const line = esc(raw);

  const h = line.match(/^(#{1,6})(\s+)(.*)$/);
  if (h) {
    const lvl = h[1].length;
    // Hashes (and their space) reveal only while the caret touches the
    // prefix region — a re-entered heading stays looking rendered.
    return `<span class="md-h${lvl}"><span class="md-tok md-pre">${mark(h[1] + h[2])}</span>${inline(h[3].replace(/([ \t]+#+[ \t]*)$/, ""))}${h[3].match(/[ \t]+#+[ \t]*$/) ? tok(mark(h[3].match(/[ \t]+#+[ \t]*$/)![0])) : ""}</span>`;
  }
  const hr = line.match(/^\s*((?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/);
  if (hr) return mark(line);

  const quote = line.match(/^((?:&gt;\s*)+)(.*)$/);
  if (quote) {
    // A `> [!NOTE]` first line marks a GitHub-style alert; tag the label so the
    // active block hints at the callout it will render into.
    const alert = quote[2].match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i);
    const body = alert
      ? `<span class="md-alert-tag md-alert-${alert[1].toLowerCase()}">${alert[0]}</span>${inline(quote[2].slice(alert[0].length))}`
      : inline(quote[2]);
    // Hidden `>` draws a quote bar via ::before so the line still reads as a quote.
    return `<span class="md-tok md-pre md-quote-pre">${mark(quote[1])}</span><span class="md-quote">${body}</span>`;
  }

  const list = line.match(/^(\s*)([-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)(.*)$/);
  if (list) {
    const marker = list[2];
    // Ordered markers stay visible: "1." already looks like the rendered
    // output — md-olnum styles it ink-colored like a real list number.
    if (/^\d/.test(marker)) {
      return `${list[1]}<span class="md-olnum">${mark(marker)}</span>${inline(list[3])}`;
    }
    const task = marker.match(/\[( |x|X)\]/);
    const cls = task ? (task[1] === " " ? "md-task" : "md-task md-done") : "md-bullet";
    return `${list[1]}<span class="md-tok md-pre ${cls}">${mark(marker)}</span>${inline(list[3])}`;
  }

  return inline(line);
}

/** True for a pipe-table separator line like `| --- | :-: |`. */
function isTableSeparator(raw: string): boolean {
  if (!raw.includes("|") || !raw.includes("-")) return false;
  const cells = raw.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length >= 1 && cells.every((c) => /^\s*:?-+:?\s*$/.test(c));
}

type ColAlign = "left" | "center" | "right" | null;

/** Per-column alignment from a separator line's `:` markers (`:-:` → center). */
function columnAligns(sep: string): ColAlign[] {
  const cells = sep.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.map((c) => {
    const s = c.trim();
    const left = s.startsWith(":");
    const right = s.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });
}

/**
 * One table source line as a CSS table row: pipes become hidden .md-pipe
 * marks, cell content becomes .md-tcell (laid out as table cells), and the
 * separator row is display:none entirely. Split/join on "|" keeps the row's
 * textContent identical to the source line.
 */
function styleTableRow(raw: string, isSep: boolean, aligns: ColAlign[]): string {
  const line = esc(raw);
  const parts = splitPipeRow(line);
  let html = `<span class="md-trow${isSep ? " md-tsep" : ""}">`;
  let col = 0; // index into aligns — advances once per emitted cell
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) html += `<span class="md-mark md-pipe">|</span>`;
    // Empty text outside the outermost pipes isn't a cell — keeping it bare
    // avoids phantom empty columns.
    if ((i === 0 || i === parts.length - 1) && parts[i] === "") continue;
    const a = aligns[col++];
    const style = a ? ` style="text-align:${a}"` : "";
    html += `<span class="md-tcell"${style}>${isSep ? mark(parts[i]) : inline(parts[i])}</span>`;
  }
  return html + "</span>";
}

function styleFlatSource(src: string): string {
  if (!src) return "";
  const lines = src.split("\n");

  // Whole-block fenced code (the common shape: opening fence first line,
  // closing fence last line): conceal the fence lines as caret-scoped tokens
  // so the active block's height matches the rendered code box. Each fence
  // span swallows its adjacent newline so the line collapses completely;
  // textContent is still byte-identical.
  const fenceLine = (s: string) => /^\s*(`{3,}|~{3,})/.test(s);
  if (lines.length >= 2 && fenceLine(lines[0]) && fenceLine(lines[lines.length - 1])) {
    const inner = lines.slice(1, -1);
    const open = `<span class="md-tok md-fence"><span class="md-mark">${esc(lines[0])}\n</span></span>`;
    const close = `<span class="md-tok md-fence"><span class="md-mark">${inner.length ? "\n" : ""}${esc(lines[lines.length - 1])}</span></span>`;
    const body = inner.map((l) => `<span class="md-code-line">${esc(l)}</span>`).join("\n");
    return open + body + close;
  }
  const out: string[] = [];
  let inFence = false;
  let fenceMark = "";
  let inMeta = lines[0] === "---";

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (inMeta) {
      out.push(`<span class="md-meta">${esc(raw)}</span>`);
      if (i > 0 && raw.trim() === "---") inMeta = false;
      continue;
    }
    const fence = raw.match(/^(\s*)(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (!inFence) { inFence = true; fenceMark = fence[2][0]; }
      else if (fence[2][0] === fenceMark) inFence = false;
      out.push(mark(esc(raw)));
      continue;
    }
    if (inFence) {
      out.push(`<span class="md-code-line">${esc(raw)}</span>`);
      continue;
    }
    // Pipe-table run: header + separator (+ body rows) render as a real
    // table via CSS. Rows are joined with "\n" INSIDE the wrapper so the
    // block's overall textContent is unchanged.
    if (raw.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const aligns = columnAligns(lines[i + 1]);
      const rows: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].includes("|")) {
        rows.push(styleTableRow(lines[j], j === i + 1, aligns));
        j++;
      }
      out.push(`<span class="md-table">${rows.join("\n")}</span>`);
      i = j - 1;
      continue;
    }
    out.push(styleLine(raw));
  }
  return out.join("\n");
}

// Use the same block grammar as the preview. In particular a heading followed
// immediately by a list is two constructs, even inside one editor block.
const blockLexer = new Marked({ gfm: true, breaks: false });
const concealed = (s: string) => `<span class="md-layout-space">${esc(s)}</span>`;

function layoutTokens(src: string): Token[] | null {
  // Marked normalizes CRLF and can synthesize whitespace for incomplete
  // items. Fall back while typing those forms rather than changing source.
  if (src.startsWith("---\n") || /^\s*(`{3,}|~{3,})/.test(src)) return null;
  const tokens = blockLexer.lexer(src);
  if (tokens.map((token) => token.raw).join("") !== src) return null;
  return tokens.some((token) => token.type === "list" || token.type === "paragraph" || token.type === "blockquote" || token.type === "heading" || token.type === "code" || token.type === "hr") ? tokens : null;
}

export function hasSourceLayout(src: string): boolean {
  return layoutTokens(src) !== null;
}

/** Lex a list item's contents as marked's list tokenizer does (nested, not
 * top level). There a numbered line such as `3. Deep` opens a nested list;
 * top-level lexing would fold it into the paragraph above and shift the item
 * when the block activates. */
function itemTokens(src: string): Token[] {
  const lexer = new Lexer(blockLexer.defaults);
  lexer.state.top = false;
  const tokens = lexer.blockTokens(src, []);
  return tokens.map((token) => token.raw).join("") === src ? tokens : blockLexer.lexer(src);
}

function styleList(token: Tokens.List): string {
  if (!token.raw.startsWith(token.items.map((item) => item.raw).join(""))) {
    return styleFlatSource(token.raw);
  }
  let consumed = 0;
  const items = token.items.map((item, index) => {
    const raw = index === token.items.length - 1 ? token.raw.slice(consumed) : item.raw;
    consumed += raw.length;
    const prefix = raw.match(/^([ \t]*)(?:[-+*]|\d+[.)])([ \t]+|$)/);
    if (!prefix) return styleFlatSource(raw);
    let markerLength = prefix[0].length;
    if (item.task) markerLength += raw.slice(markerLength).match(/^\[[ xX]\][ \t]+/)?.[0].length ?? 0;
    const marker = raw.slice(0, markerLength);
    const tail = raw.slice(markerLength).match(/\n*$/)![0];
    const body = raw.slice(markerLength, tail ? -tail.length : undefined);
    // Dedent for parsing, then restore each removed source indent as hidden
    // text. This retains exact offsets, including nested lists and soft wraps.
    const indents: string[] = [];
    const normalized = body.replace(/\n([ \t]*)/g, (_, spaces: string) => {
      const removed = spaces.slice(0, prefix[0].length);
      indents.push(removed);
      return "\n" + spaces.slice(removed.length);
    });
    let html = styleLayoutTokens(itemTokens(normalized), !token.loose);
    let line = 0;
    html = html.replace(/\n/g, () => "\n" + concealed(indents[line++] ?? ""));
    const cls = item.task ? `md-task${item.checked ? " md-done" : ""}`
      : token.ordered ? "md-olnum" : "md-bullet";
    const number = token.ordered ? ` data-number="${Number(token.start) + index}."` : "";
    return `<span class="md-list-item${item.task ? " md-list-task" : ""}"><span class="md-tok md-pre ${cls}"${number}>${mark(esc(marker))}</span>${html}${concealed(tail)}</span>`;
  });
  return `<span class="md-list">${items.join("")}${concealed(token.raw.slice(consumed))}</span>`;
}

/** Highlight only source text that survives byte-for-byte. Shiki's <pre>
 * wrapper is replaced by a source span so list indentation and fence markers
 * can remain in the same contenteditable, with no duplicate preview text. */
function styleCodeContent(source: string, lang: string): string {
  const highlighted = liveCodeHighlighter(source, lang);
  if (highlighted && typeof document !== "undefined") {
    const template = document.createElement("template");
    template.innerHTML = highlighted;
    const code = template.content.querySelector("pre > code");
    if (code?.textContent === source) return code.innerHTML;
  }
  return esc(source);
}

function styleCode(token: Tokens.Code): string {
  const raw = token.raw;
  const opening = raw.match(/^([ \t]*)(`{3,}|~{3,})[^\n]*(?:\n|$)/);
  const lang = (token.lang ?? "").split(/\s+/)[0];
  let body: string;
  let open = "";
  let close = "";
  let indent = 4; // indented Markdown code
  if (opening && token.codeBlockStyle !== "indented") {
    open = opening[0];
    indent = opening[1].length;
    const rest = raw.slice(open.length);
    const marker = opening[2];
    const closing = new RegExp(`(?:^|\\n)[ \t]*${marker[0]}{${marker.length},}[ \t]*(?:\\n)?$`).exec(rest);
    body = closing ? rest.slice(0, closing.index) : rest;
    close = closing ? rest.slice(closing.index) : "";
  } else {
    // The final newline is a block separator, not another visible code line.
    const tail = raw.match(/\n+$/)?.[0] ?? "";
    body = tail ? raw.slice(0, -tail.length) : raw;
    close = tail;
  }
  const prefixes: string[] = [];
  const code = body.split("\n").map((line) => {
    const prefix = !opening && line.startsWith("\t") ? "\t" : line.match(new RegExp(`^[ ]{0,${indent}}`))![0];
    prefixes.push(prefix);
    return line.slice(prefix.length);
  }).join("\n");
  let line = 1;
  const content = concealed(prefixes[0] ?? "") + styleCodeContent(code, lang)
    .replace(/\n/g, () => "\n" + concealed(prefixes[line++] ?? ""));
  const fence = (source: string) => `<span class="md-tok md-fence">${mark(esc(source))}</span>`;
  return `<span class="md-layout-code shiki">${open ? fence(open) : ""}<span class="md-code-content">${content}</span>${opening ? fence(close) : concealed(close)}</span>`;
}

/** Quote markers remain source text, but the quote itself is one continuous
 * box, using the same block grammar as preview (including nested lists/code). */
function styleQuote(token: Tokens.Blockquote): string {
  const prefixes: string[] = [];
  const normalized = token.raw.split("\n").map((line) => {
    const prefix = line.match(/^ {0,3}>[ \t]?/)?.[0] ?? "";
    prefixes.push(prefix);
    return line.slice(prefix.length);
  }).join("\n");
  const alert = normalized.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\n)?/i);
  let html: string;
  let cls = "md-layout-quote";
  if (alert) {
    const type = alert[1].toLowerCase();
    const label = type[0].toUpperCase() + type.slice(1);
    cls = `md-alert md-alert-${type}`;
    html = `<span class="md-alert-title md-source-alert-title" data-label="${label}"><span class="md-tok md-alert-tag md-alert-${type}">${mark(esc(alert[0]))}</span></span>`
      + styleLayoutTokens(blockLexer.lexer(normalized.slice(alert[0].length)));
  } else {
    html = styleLayoutTokens(blockLexer.lexer(normalized));
  }
  const prefix = (index: number) => prefixes[index]
    ? `<span class="md-tok md-quote-pre md-quote-prefix">${mark(esc(prefixes[index]))}</span>` : "";
  let line = 1;
  html = prefix(0) + html.replace(/\n/g, () => "\n" + prefix(line++));
  return `<span class="${cls}">${html}</span>`;
}

function styleLayoutTokens(tokens: Token[], tight = false): string {
  return tokens.map((token) => {
    if (token.type === "list") return styleList(token as Tokens.List);
    if (token.type === "blockquote") return styleQuote(token as Tokens.Blockquote);
    if (token.type === "code") return styleCode(token as Tokens.Code);
    if (token.type === "space" || token.type === "def") return concealed(token.raw);
    const raw = token.raw;
    const tail = raw.match(/\n*$/)![0];
    const body = tail ? raw.slice(0, -tail.length) : raw;
    // Setext: text over an =/- underline. Decide by the underline, not by
    // "# " — a bare "#" is an empty ATX heading, and concealing it as an
    // underline hid the text the caret had just typed.
    if (token.type === "heading" && /\n[ \t]*(?:=+|-+)[ \t]*$/.test(body)) {
      const heading = token as Tokens.Heading;
      const end = body.lastIndexOf("\n");
      return `<span class="md-layout-heading md-layout-h${heading.depth}"><span class="md-h${heading.depth}">${inline(esc(body.slice(0,end)))}</span>${concealed(body.slice(end))}</span>${concealed(tail)}`;
    }
    if (token.type === "hr") return `<span class="md-live-hr">${concealed(raw)}<hr></span>`;
    if (token.type === "heading") {
      return `<span class="md-layout-heading md-layout-h${(token as Tokens.Heading).depth}">${styleFlatSource(body)}</span>${concealed(tail)}`;
    }
    if (token.type === "paragraph" || token.type === "text") {
      // Layout blocks keep typed spaces literal (pre-wrap), so a soft line
      // break, with any blanks around it, gets its own collapsing span that
      // reads as one space, as it does in preview.
      const lines = inline(esc(body)).replace(/(?: {2,}|\\)\n|[ \t]*\n[ \t]*/g, (br) => /^(?: {2,}|\\)\n$/.test(br)
        ? `${concealed(br.slice(0, -1))}<span class="md-hard-break">\n</span>`
        : `<span class="md-soft">${br}</span>`);
      return `<span class="md-layout-paragraph${tight ? " md-tight" : ""}">${lines}</span>${concealed(tail)}`;
    }
    return `<span class="md-layout-literal">${styleFlatSource(raw)}</span>`;
  }).join("");
}

/**
 * Source for a complex block's editing card (diagram, equation, metadata):
 * the delimiter lines stay visible as muted markers, and the body is coloured
 * with its language's grammar (mermaid, latex, yaml). textContent stays
 * byte-identical; styleCodeContent falls back to plain text if highlighting
 * would change it, or until the grammar has loaded.
 */
export function stylePanelSource(src: string): string {
  const marker = (s: string) => `<span class="md-tok md-fence"><span class="md-mark">${esc(s)}</span></span>`;
  // `.shiki` on the body opts it into the dark themes' --shiki-dark palette,
  // exactly like code blocks; the delimiter markers keep the marker colour.
  const wrap = (open: string, body: string, close: string, lang: string) =>
    marker(open) + `<span class="shiki">${styleCodeContent(body, lang)}</span>` + marker(close);
  const fence = /^([ \t]*(`{3,}|~{3,})[ \t]*([^\s`]*)[^\n]*\n)([\s\S]*?)(\n[ \t]*\2[`~]*[ \t]*)$/.exec(src);
  if (fence) {
    const lang = fence[3].toLowerCase();
    return wrap(fence[1], fence[4], fence[5], lang === "math" ? "latex" : lang);
  }
  const math = /^(\$\$|\\\[)([\s\S]*?)(\$\$|\\\])$/.exec(src);
  if (math) return wrap(math[1], math[2], math[3], "latex");
  const meta = /^(---\n)([\s\S]*?)(\n---)$/.exec(src);
  if (meta) return wrap(meta[1], meta[2], meta[3], "yaml");
  return esc(src);
}

export function styleSource(src: string): string {
  const tokens = layoutTokens(src);
  // Keep specialized fence/table editing; structured layout keeps
  // soft-wrapped paragraphs and lists consistent with preview.
  return tokens ? styleLayoutTokens(tokens) : styleFlatSource(src);
}

/**
 * Reveal syntax only while the caret is in a delimiter, never in its styled
 * content. Text clicks preserve preview layout. Hidden source stays in the DOM
 * for exact caret offsets and is reachable by moving through delimiter edges.
 */
export function applyMarkerVisibility(el: HTMLElement, source: string, caret: number) {
  const c = Math.max(0, Math.min(caret, source.length));

  // One DFS accumulating text length; an element's source range spans from
  // the offset before its children to the offset after them. Nested tokens
  // (a link inside bold) get independent ranges for free.
  let pos = 0;
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pos += (node as Text).data.length;
      return;
    }
    const start = pos;
    let inMarker = false;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      const markerStart = pos;
      walk(child);
      if (child instanceof HTMLElement && child.classList.contains("md-mark")) {
        // Text clicks must not expose syntax and reflow the paragraph. Reveal
        // only when navigating into a delimiter. Exclude the content-facing
        // boundary so clicking the first/last styled character stays rendered.
        const opening = child === node.firstChild;
        inMarker ||= opening ? c >= markerStart && c < pos : c > markerStart && c <= pos;
      }
    }
    const end = pos;
    if (node instanceof HTMLElement && node.classList.contains("md-tok")) {
      const nestedFence = node.classList.contains("md-fence") && node.parentElement?.classList.contains("md-layout-code");
      const showFence = nestedFence
        ? (node.nextElementSibling?.classList.contains("md-code-content") ? c >= start && c < end : c > start && c <= end)
        : c >= start && c <= end;
      node.classList.toggle("md-on", node.classList.contains("md-fence")
        ? showFence : inMarker || (node.classList.contains("md-pre") && c === end && end === source.length));
    }
  };
  walk(el);
}

/** Shadow previews do not add duplicate text to the editable source tree.
 * This keeps range offsets exact while equations retain their rendered size.
 */
/**
 * KaTeX rules for the shadow previews, collected once (re-collected only if
 * the set of stylesheets changes) rather than by walking every rule of every
 * sheet on each keystroke. Rules scoped to `.rendered` apply unscoped: a
 * preview *is* rendered output, and without that the app's
 * `.rendered .katex { font-size }` never matched inside the shadow root, so
 * live formulas came out ~15% wider than the preview's and reflowed the line.
 */
let previewStyleCache: { sheets: number; css: string } | null = null;
function previewStyles(): string {
  const sheets = document.styleSheets.length;
  if (previewStyleCache?.sheets === sheets) return previewStyleCache.css;
  const rules: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.cssText.includes(".katex")) rules.push(rule.cssText.replace(/(^|,\s*)\.rendered\s+/g, "$1"));
      }
    } catch { /* Cross-origin stylesheets cannot be inspected. */ }
  }
  const css = rules.join("\n") + "\n:host { display:inline-block; } p { display:contents; margin:0; }";
  previewStyleCache = { sheets, css };
  return css;
}

export function hydrateInlinePreviews(el: HTMLElement, render: (source: string) => string, edit: (offset: number) => void) {
  const previews = el.querySelectorAll<HTMLElement>(".md-inline-preview");
  if (!previews.length) return;
  const styles = previewStyles();
  for (const preview of previews) {
    const shadow = preview.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = styles;
    shadow.append(style);
    const body = document.createElement("span");
    body.innerHTML = render(preview.dataset.markdown ?? "");
    shadow.append(body);
    preview.addEventListener("mousedown", event => {
      event.preventDefault(); event.stopPropagation();
      const range = document.createRange(); range.selectNodeContents(el); range.setEndBefore(preview.parentElement!);
      edit(range.toString().length + 1);
    });
  }
}

/* ---------- caret utilities for contenteditable ---------- */

export function getSelectionOffsets(el: HTMLElement): { start: number; end: number } {
  const sel = window.getSelection();
  const len = el.textContent?.length ?? 0;
  if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return { start: len, end: len };
  const range = sel.getRangeAt(0);
  const pre = range.cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  pre.setEnd(range.endContainer, range.endOffset);
  return { start, end: pre.toString().length };
}

export function getCaretOffset(el: HTMLElement): number {
  return getSelectionOffsets(el).start;
}

export function setCaret(el: HTMLElement, offset: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const range = document.createRange();
  let remaining = Math.max(0, Math.min(offset, el.textContent?.length ?? 0));
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    // At a concealed prefix's end, prefer the following visible text node.
    // Otherwise WebKit can move the caret to the block start on activation.
    const hiddenMarker = node.parentElement?.closest(".md-mark")?.parentElement;
    const skipBoundary = remaining === len && hiddenMarker?.classList.contains("md-tok")
      && !hiddenMarker.classList.contains("md-on");
    if (remaining <= len && !skipBoundary) {
      range.setStart(node, remaining);
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  range.selectNodeContents(el);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Select a [start, end) text-offset range inside a contenteditable. */
export function setSelection(el: HTMLElement, start: number, end: number) {
  const sel = window.getSelection();
  if (!sel) return;
  const max = el.textContent?.length ?? 0;
  const from = Math.max(0, Math.min(start, max));
  const to = Math.max(from, Math.min(end, max));
  const range = document.createRange();
  let pos = 0;
  let startSet = false;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode() as Text | null;
  while (node) {
    const len = node.data.length;
    if (!startSet && from <= pos + len) {
      range.setStart(node, from - pos);
      startSet = true;
    }
    if (startSet && to <= pos + len) {
      range.setEnd(node, to - pos);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    pos += len;
    node = walker.nextNode() as Text | null;
  }
  if (startSet) {
    range.setEnd(el, el.childNodes.length);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}

/**
 * Map a click position in rendered HTML to an offset in the markdown
 * source: rendered text is (approximately) an ordered subsequence of the
 * source, so walk both and skip source characters that don't match.
 */
export function mapRenderedPrefixToSource(source: string, renderedPrefix: string): number {
  let i = 0;
  let stalled = 0;
  for (let j = 0; j < renderedPrefix.length && i < source.length; ) {
    const entity = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z0-9]+);/i.exec(source.slice(i));
    const emojiMatch = emojiShortcode().exec(source.slice(i));
    const emoji = emojiMatch?.index === 0 ? emojiMatch : null;
    let replacement = "", length = 0;
    if (entity) {
      const el = document.createElement("textarea"); el.innerHTML = entity[0];
      replacement = el.value; length = entity[0].length;
    } else if (emoji) { replacement = emojiFor(emoji[1]) ?? ""; length = emoji[0].length; }
    if (replacement && renderedPrefix.slice(j).startsWith(replacement)) {
      i += length; j += replacement.length; stalled = 0; continue;
    }
    // Callout titles are generated labels ("Note"), not literal source
    // ("[!NOTE]"). Consume them as a unit so a body click cannot run past the
    // intended word while searching for the title's differently-cased text.
    const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.exec(source.slice(i));
    if (alert) {
      const label = alert[1][0].toUpperCase() + alert[1].slice(1).toLowerCase();
      const rest = renderedPrefix.slice(j);
      if (rest.startsWith(label) || label.startsWith(rest)) {
        i += alert[0].length;
        j += Math.min(rest.length, label.length);
        i += source.slice(i).match(/^[ \t]*(?:\n[ \t]*>[ \t]?)?/)![0].length;
        stalled = 0;
        continue;
      }
    }
    // Renderer-added newlines between block/list tags have no source
    // counterpart. Never search forward through item text to match them.
    if (/\s/.test(renderedPrefix[j])) {
      if (/\s/.test(source[i])) i++;
      j++;
      stalled = 0;
    }
    else if (source[i] === renderedPrefix[j]) { i++; j++; stalled = 0; }
    else { i++; if (++stalled > 80) { j++; stalled = 0; } }
  }
  return Math.min(i, source.length);
}
