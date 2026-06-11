/**
 * Live-styled Markdown source — the Typora behavior.
 * The active block shows its raw source, but markers are dimmed and
 * content is styled in real time as you type. Rendering to final HTML
 * happens only when the caret leaves the block (Enter / blur / Esc).
 */

const P_OPEN = "\uE000";
const P_CLOSE = "\uE001";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const mark = (s: string) => `<span class="md-mark">${s}</span>`;

/** Style inline markdown inside one already-escaped line. */
function inline(text: string): string {
  const tokens: string[] = [];
  const stash = (html: string) => {
    tokens.push(html);
    return P_OPEN + (tokens.length - 1) + P_CLOSE;
  };

  let t = text;
  // code spans first — their content must stay literal
  t = t.replace(/`([^`\n]+)`/g, (_, c) =>
    stash(`${mark("`")}<span class="md-codespan">${c}</span>${mark("`")}`)
  );
  // images
  t = t.replace(/!\[([^\]\n]*)\]\(([^)\n]*)\)/g, (_, alt, url) =>
    stash(`${mark("![")}<span class="md-link">${alt}</span>${mark("](")}<span class="md-url">${url}</span>${mark(")")}`)
  );
  // links
  t = t.replace(/\[([^\]\n]+)\]\(([^)\n]*)\)/g, (_, label, url) =>
    stash(`${mark("[")}<span class="md-link">${label}</span>${mark("](")}<span class="md-url">${url}</span>${mark(")")}`)
  );
  // bold
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_, m, body) =>
    stash(`${mark(m)}<strong>${body}</strong>${mark(m)}`)
  );
  // italic
  t = t.replace(/(\*|_)(?=\S)([^*_\n]*?\S)\1/g, (_, m, body) =>
    stash(`${mark(m)}<em>${body}</em>${mark(m)}`)
  );
  // strikethrough
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, body) =>
    stash(`${mark("~~")}<del>${body}</del>${mark("~~")}`)
  );

  // restore (tokens may nest one level via bold-inside-link etc.)
  for (let pass = 0; pass < 3; pass++) {
    t = t.replace(new RegExp(P_OPEN + "(\\d+)" + P_CLOSE, "g"), (_, i) => tokens[Number(i)]);
    if (!t.includes(P_OPEN)) break;
  }
  return t;
}

/** Style one escaped line with its block-level construct. */
function styleLine(raw: string): string {
  const line = esc(raw);

  const h = line.match(/^(#{1,6})(\s+)(.*)$/);
  if (h) {
    const lvl = h[1].length;
    return `<span class="md-h${lvl}">${mark(h[1])}${h[2]}${inline(h[3])}</span>`;
  }
  const hr = line.match(/^\s*((?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/);
  if (hr) return mark(line);

  const quote = line.match(/^((?:&gt;\s*)+)(.*)$/);
  if (quote) return `${mark(quote[1])}<span class="md-quote">${inline(quote[2])}</span>`;

  const list = line.match(/^(\s*)([-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)(.*)$/);
  if (list) return `${list[1]}${mark(list[2])}${inline(list[3])}`;

  return inline(line);
}

export function styleSource(src: string): string {
  if (!src) return "";
  const lines = src.split("\n");
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
    out.push(styleLine(raw));
  }
  return out.join("\n");
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
    if (remaining <= len) {
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

/**
 * Map a click position in rendered HTML to an offset in the markdown
 * source: rendered text is (approximately) an ordered subsequence of the
 * source, so walk both and skip source characters that don't match.
 */
export function mapRenderedPrefixToSource(source: string, renderedPrefix: string): number {
  let i = 0;
  let stalled = 0;
  for (let j = 0; j < renderedPrefix.length && i < source.length; ) {
    if (source[i] === renderedPrefix[j]) { i++; j++; stalled = 0; }
    else { i++; if (++stalled > 80) { j++; stalled = 0; } }
  }
  return Math.min(i, source.length);
}
