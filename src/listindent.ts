/**
 * Indenting and outdenting list items (Tab / Shift+Tab and Paragraph >
 * List Indentation), issue #53.
 *
 * An item moves with everything that belongs to it (its continuation lines and
 * nested items), by exactly the amount that makes it a child of the item above
 * (indent) or a sibling of its parent (outdent). The caret keeps its place in
 * the text, so typing carries on where it was.
 */

const ITEM = /^([ \t]*)([-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+|[-*+]$|\d+[.)]$)/;

export interface ListShift {
  text: string;
  start: number;
  end: number;
}

const cols = (ws: string) => ws.replace(/\t/g, "    ").length;

interface Line { from: number; text: string; lead: string; item: RegExpMatchArray | null }

function lines(text: string): Line[] {
  const out: Line[] = [];
  let from = 0;
  for (const t of text.split("\n")) {
    out.push({ from, text: t, lead: t.match(/^[ \t]*/)![0], item: t.match(ITEM) });
    from += t.length + 1;
  }
  return out;
}

/** Column where an item's content starts ("- " → 2, "10. " → 4). */
const contentCol = (l: Line) => cols(l.item![1]) + cols(l.item![2]) + (/[ \t]$/.test(l.item![2]) ? 0 : 1);

/**
 * Shift the list item under `start` one level in (`dir` 1) or out (`dir` -1).
 * Returns null when that line is not a list item, so the caller can fall back
 * to its plain behaviour. Returns the text unchanged when the item can't move
 * (the first item has nothing to nest under; a top-level item can't go out).
 */
export function shiftListItem(text: string, start: number, end: number, dir: 1 | -1): ListShift | null {
  const ls = lines(text);
  const at = ls.findIndex((l, i) => i === ls.length - 1 || start < ls[i + 1].from);
  const line = ls[at];
  if (!line?.item) return null;
  const width = cols(line.lead);

  let target: number | null = null;
  for (let k = at - 1; k >= 0; k--) {
    const l = ls[k];
    if (l.text.trim() === "") continue;
    const w = cols(l.lead);
    if (dir === 1) {
      // The sibling just above becomes the parent.
      if (l.item && w === width) { target = contentCol(l); break; }
      if (w < width) break;
    } else if (l.item && w < width) {
      // A sibling of the parent.
      target = w;
      break;
    }
  }
  if (dir === -1 && target === null && width > 0) target = 0;
  if (target === null || target === width) return { text, start, end };
  const delta = target - width;

  // The item's own lines: everything after it indented past its marker
  // (continuations and nested items), not trailing blank lines.
  const inner = contentCol(line);
  let last = at;
  for (let k = at + 1; k < ls.length; k++) {
    if (ls[k].text.trim() === "") continue;
    if (cols(ls[k].lead) < inner) break;
    last = k;
  }

  const shifts: { from: number; oldLead: number; newLead: number }[] = [];
  const out = ls.map((l, k) => {
    if (k < at || k > last || l.text.trim() === "") return l.text;
    const lead = " ".repeat(Math.max(0, cols(l.lead) + delta));
    shifts.push({ from: l.from, oldLead: l.lead.length, newLead: lead.length });
    return lead + l.text.slice(l.lead.length);
  });

  const map = (pos: number) => {
    let moved = 0;
    for (const s of shifts) {
      if (pos < s.from) break;
      const col = pos - s.from;
      if (col >= s.oldLead) moved += s.newLead - s.oldLead;
      else return pos + moved - col + Math.min(col, s.newLead);
    }
    return pos + moved;
  };
  return { text: out.join("\n"), start: map(start), end: map(end) };
}
