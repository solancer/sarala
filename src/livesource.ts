/**
 * Live-styled Markdown source — the Typora behavior.
 * The active block shows its raw source, but markers are dimmed and
 * content is styled in real time as you type. Rendering to final HTML
 * happens only when the caret leaves the block (Enter / blur / Esc).
 */

const P_OPEN = "\uE000";
const P_CLOSE = "\uE001";

// Mirror the renderer's inline-syntax prefs so the active block styles only
// what will actually render. textContent stays byte-identical either way \u2014
// these only gate visual styling, never alter source text.
let liveHighlight = true;
let liveSubSup = true;
export function setLiveHighlight(on: boolean) { liveHighlight = on; }
export function setLiveSubSup(on: boolean) { liveSubSup = on; }

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
    stash(tok(`${mark("`")}<span class="md-codespan">${c}</span>${mark("`")}`))
  );
  // images — the URL span is also an md-mark so it hides with the brackets
  t = t.replace(/!\[([^\]\n]*)\]\(([^)\n]*)\)/g, (_, alt, url) =>
    stash(tok(`${mark("![")}<span class="md-link">${alt}</span>${mark("](")}<span class="md-mark md-url">${url}</span>${mark(")")}`))
  );
  // links
  t = t.replace(/\[([^\]\n]+)\]\(([^)\n]*)\)/g, (_, label, url) =>
    stash(tok(`${mark("[")}<span class="md-link">${label}</span>${mark("](")}<span class="md-mark md-url">${url}</span>${mark(")")}`))
  );
  // bold
  t = t.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, (_, m, body) =>
    stash(tok(`${mark(m)}<strong>${body}</strong>${mark(m)}`))
  );
  // italic
  t = t.replace(/(\*|_)(?=\S)([^*_\n]*?\S)\1/g, (_, m, body) =>
    stash(tok(`${mark(m)}<em>${body}</em>${mark(m)}`))
  );
  // strikethrough (must run before single-tilde subscript so ~~ wins)
  t = t.replace(/~~(?=\S)([\s\S]*?\S)~~/g, (_, body) =>
    stash(tok(`${mark("~~")}<del>${body}</del>${mark("~~")}`))
  );
  // highlight ==text==
  if (liveHighlight) {
    t = t.replace(/==(?=\S)([\s\S]*?\S)==/g, (_, body) =>
      stash(tok(`${mark("==")}<mark>${body}</mark>${mark("==")}`))
    );
  }
  if (liveSubSup) {
    // subscript ~text~ (single tilde; ~~ already consumed above)
    t = t.replace(/~(?![~\s])([^~\n]+?)~(?!~)/g, (_, body) =>
      stash(tok(`${mark("~")}<sub>${body}</sub>${mark("~")}`))
    );
    // superscript ^text^ (no inner whitespace)
    t = t.replace(/\^(?!\s)([^\^\s]+?)\^/g, (_, body) =>
      stash(tok(`${mark("^")}<sup>${body}</sup>${mark("^")}`))
    );
  }

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
    // Hashes (and their space) reveal only while the caret touches the
    // prefix region — a re-entered heading stays looking rendered.
    return `<span class="md-h${lvl}"><span class="md-tok md-pre">${mark(h[1] + h[2])}</span>${inline(h[3])}</span>`;
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

/**
 * One table source line as a CSS table row: pipes become hidden .md-pipe
 * marks, cell content becomes .md-tcell (laid out as table cells), and the
 * separator row is display:none entirely. Split/join on "|" keeps the row's
 * textContent identical to the source line.
 */
function styleTableRow(raw: string, isSep: boolean): string {
  const line = esc(raw);
  const parts = line.split("|");
  let html = `<span class="md-trow${isSep ? " md-tsep" : ""}">`;
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) html += `<span class="md-mark md-pipe">|</span>`;
    // Empty text outside the outermost pipes isn't a cell — keeping it bare
    // avoids phantom empty columns.
    if ((i === 0 || i === parts.length - 1) && parts[i] === "") continue;
    html += `<span class="md-tcell">${isSep ? mark(parts[i]) : inline(parts[i])}</span>`;
  }
  return html + "</span>";
}

export function styleSource(src: string): string {
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
      const rows: string[] = [];
      let j = i;
      while (j < lines.length && lines[j].includes("|")) {
        rows.push(styleTableRow(lines[j], j === i + 1));
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

/**
 * Typora-style caret-scoped reveal: toggle .md-on on every .md-tok in a
 * live-styled block. A token reveals while the caret sits inside its source
 * range, edges inclusive — completing `**bold**` leaves the caret on the end
 * edge so the pair stays revealed, and a list/heading prefix reveals when the
 * caret reaches the start of the line's text (its end edge), which also keeps
 * hidden markers reachable by arrow keys (browsers skip display:none text, so
 * the caret lands on the edge and the reveal makes the marker traversable).
 * Pure class toggling: the DOM text is never altered, so textContent stays
 * byte-identical to the source.
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
    for (let child = node.firstChild; child; child = child.nextSibling) walk(child);
    const end = pos;
    if (node instanceof HTMLElement && node.classList.contains("md-tok")) {
      node.classList.toggle("md-on", c >= start && c <= end);
    }
  };
  walk(el);
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
    if (source[i] === renderedPrefix[j]) { i++; j++; stalled = 0; }
    else { i++; if (++stalled > 80) { j++; stalled = 0; } }
  }
  return Math.min(i, source.length);
}
