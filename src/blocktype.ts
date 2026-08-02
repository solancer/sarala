/**
 * Block-construct detection and conversion over raw Markdown source.
 *
 * The existing `paragraph.*` commands are *toggles* (`toggleList`,
 * `toggleQuote`) — right for a menu item, wrong for a dropdown that has to
 * mean "make this block a bullet list" regardless of what it is now. These
 * helpers do the set-to-kind conversion instead: strip whatever prefix each
 * line carries, then apply the target one.
 */

export type BlockKind =
  | "paragraph"
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
  | "bullet"
  | "ordered"
  | "task"
  | "quote"
  | "code";

const isFence = (line: string) => /^\s*(`{3,}|~{3,})/.test(line);

/** The construct a block currently is, judged by its first non-blank line. */
export function blockKind(text: string): BlockKind {
  const lines = text.split("\n");
  if (isFence(lines[0])) return "code";
  const first = lines.find((l) => l.trim() !== "") ?? "";
  const h = first.match(/^\s*(#{1,6})\s/);
  if (h) return `h${h[1].length}` as BlockKind;
  if (/^\s*>/.test(first)) return "quote";
  if (/^\s*[-*+]\s+\[[ xX]\]\s/.test(first)) return "task";
  if (/^\s*[-*+]\s/.test(first)) return "bullet";
  if (/^\s*\d+[.)]\s/.test(first)) return "ordered";
  return "paragraph";
}

// Quote before heading so `> # Title` unwraps in one pass per level.
const PREFIXES = [
  /^\s*>\s?/,
  /^\s*#{1,6}\s+/,
  /^\s*[-*+]\s+\[[ xX]\]\s+/,
  /^\s*(?:[-*+]|\d+[.)])\s+/,
];

/** A line's text with any block construct (and its indent) removed. */
function stripPrefix(line: string): string {
  let out = line;
  // Two passes unwrap one level of nesting (a heading inside a quote).
  for (let pass = 0; pass < 2; pass++) {
    for (const re of PREFIXES) out = out.replace(re, "");
  }
  return out.trimStart();
}

export interface BlockEdit {
  text: string;
  /** Map an offset in the old source onto the equivalent offset in the new. */
  map: (offset: number) => number;
}

/**
 * Rewrite a block as `kind`. Returns a mapping alongside the new source so the
 * caller can keep the user's selection on the same words — prefixes change
 * length per line, so a flat delta would drift on multi-line blocks.
 */
export function applyBlockKind(text: string, kind: BlockKind): BlockEdit {
  const lines0 = text.split("\n");
  const fenced =
    lines0.length >= 2 && isFence(lines0[0]) && isFence(lines0[lines0.length - 1]);

  if (kind === "code") {
    if (fenced) return { text, map: (o) => o };
    return { text: "```\n" + text + "\n```", map: (o) => o + "```\n".length };
  }

  // Converting away from a code block drops the opening fence line first;
  // every offset inside shifts back by its length (plus its newline).
  const shift = fenced ? -(lines0[0].length + 1) : 0;
  const bare = fenced ? lines0.slice(1, -1).join("\n") : text;
  const lines = bare.split("\n");

  const out: string[] = [];
  const rows: { srcStart: number; srcLen: number; outStart: number; removed: number; added: number }[] = [];
  let srcPos = 0;
  let outPos = 0;
  let ordinal = 0;

  // A blank line inside a multi-line block stays blank (a gap in a list must
  // not sprout a bullet), but a wholly empty block still takes the prefix —
  // that is the slash menu's case, where `/h2` converts an otherwise blank line.
  const allBlank = bare.trim() === "";

  for (const line of lines) {
    let outLine = "";
    let removed = line.length;
    let added = 0;
    if (line.trim() !== "" || allBlank) {
      const core = stripPrefix(line);
      removed = line.length - core.length;
      let prefix: string;
      switch (kind) {
        case "paragraph": prefix = ""; break;
        case "bullet": prefix = "- "; break;
        case "ordered": prefix = `${++ordinal}. `; break;
        case "task": prefix = "- [ ] "; break;
        case "quote": prefix = "> "; break;
        default: prefix = "#".repeat(Number(kind.slice(1))) + " ";
      }
      added = prefix.length;
      outLine = prefix + core;
    }
    rows.push({ srcStart: srcPos, srcLen: line.length, outStart: outPos, removed, added });
    out.push(outLine);
    srcPos += line.length + 1;
    outPos += outLine.length + 1;
  }

  const next = out.join("\n");
  const map = (offset: number) => {
    const o = Math.max(0, Math.min(offset + shift, bare.length));
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      if (o < r.srcStart) continue;
      const col = Math.min(o - r.srcStart, r.srcLen);
      const outCol = r.added + Math.max(0, col - r.removed);
      return Math.min(r.outStart + outCol, next.length);
    }
    return 0;
  };
  return { text: next, map };
}
