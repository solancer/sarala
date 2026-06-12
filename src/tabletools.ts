/**
 * GFM pipe-table parsing and editing for the Paragraph ▸ Table menu.
 *
 * Unit-style asserts (shape of the contract):
 *   parseTable("| a | b |\n| --- | :-: |\n| 1 | 2 |")
 *     → { align: [null, "center"], rows: [["a","b"], ["1","2"]] }
 *   serializeTable(parseTable(t))    round-trips cell content
 *   parseTable("not a table")        → null
 *   skeletonTable(2, 3)              → header + separator + 2 empty body rows
 */

export type Align = "left" | "center" | "right" | null;

export interface PipeTable {
  align: Align[];
  /** rows[0] is the header row; the separator line is implicit. */
  rows: string[][];
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

const SEPARATOR_CELL = /^:?-{1,}:?$/;

export function parseTable(text: string): PipeTable | null {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2 || !lines.every((l) => l.includes("|"))) return null;
  const sep = splitRow(lines[1]);
  if (!sep.length || !sep.every((c) => SEPARATOR_CELL.test(c))) return null;

  const align: Align[] = sep.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const width = align.length;
  const rows = [lines[0], ...lines.slice(2)].map((l) => {
    const cells = splitRow(l);
    while (cells.length < width) cells.push("");
    return cells.slice(0, width);
  });
  return { align, rows };
}

export function serializeTable(t: PipeTable): string {
  const sep = t.align.map((a) => {
    if (a === "center") return ":---:";
    if (a === "right") return "---:";
    if (a === "left") return ":---";
    return "---";
  });
  const row = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [row(t.rows[0]), row(sep), ...t.rows.slice(1).map(row)].join("\n");
}

/** New table markdown: `cols` columns, a header, and `rows` empty body rows. */
export function skeletonTable(rows: number, cols: number): string {
  const n = Math.max(1, Math.min(cols, 16));
  const m = Math.max(1, Math.min(rows, 64));
  const header = Array.from({ length: n }, (_, i) => `Column ${i + 1}`);
  const empty = Array.from({ length: n }, () => "  ");
  return serializeTable({
    align: Array.from({ length: n }, () => null),
    rows: [header, ...Array.from({ length: m }, () => [...empty])],
  });
}

/** Line number (0-based) of a text offset; line 1 is the separator. */
export function lineAtOffset(text: string, offset: number): number {
  return text.slice(0, Math.max(0, Math.min(offset, text.length))).split("\n").length - 1;
}

/** Index into PipeTable.rows for a source line number (separator → header). */
function rowForLine(line: number): number {
  if (line <= 1) return 0;
  return line - 1;
}

/** Column index of an offset within a table source line. */
export function columnAtOffset(text: string, offset: number): number {
  const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
  const before = text.slice(lineStart, offset);
  let pipes = 0;
  for (const ch of before) if (ch === "|") pipes++;
  return Math.max(0, before.trimStart().startsWith("|") ? pipes - 1 : pipes);
}

/** Current size of a table: total rows (incl. header) and columns. */
export function tableDims(text: string): { rows: number; cols: number } | null {
  const t = parseTable(text);
  return t ? { rows: t.rows.length, cols: t.align.length } : null;
}

/**
 * Resize to `rows` total rows (header included, min 2) and `cols` columns.
 * Existing cell content survives; growth adds empty cells/rows.
 *   resizeTable("| a |\n| --- |", 3, 2) → header gains a column, one empty
 *   body row appended; resizeTable(t, 2, 1) truncates from the bottom/right.
 */
export function resizeTable(text: string, rows: number, cols: number): string | null {
  const t = parseTable(text);
  if (!t) return null;
  const targetRows = Math.max(2, Math.min(rows, 64));
  const targetCols = Math.max(1, Math.min(cols, 16));

  t.align = t.align.slice(0, targetCols);
  while (t.align.length < targetCols) t.align.push(null);
  t.rows = t.rows.map((r) => {
    const cells = r.slice(0, targetCols);
    while (cells.length < targetCols) cells.push("  ");
    return cells;
  });

  t.rows = t.rows.slice(0, targetRows);
  while (t.rows.length < targetRows) {
    t.rows.push(Array.from({ length: targetCols }, () => "  "));
  }
  return serializeTable(t);
}

export type TableEdit =
  | { kind: "row_above" }
  | { kind: "row_below" }
  | { kind: "delete_row" }
  | { kind: "add_col" }
  | { kind: "delete_col" }
  | { kind: "align"; align: Align };

/** Apply a table edit at a caret offset; returns null if text isn't a table. */
export function editTable(text: string, offset: number, edit: TableEdit): string | null {
  const t = parseTable(text);
  if (!t) return null;
  const row = Math.min(rowForLine(lineAtOffset(text, offset)), t.rows.length - 1);
  const col = Math.min(columnAtOffset(text, offset), t.align.length - 1);
  const emptyRow = () => Array.from({ length: t.align.length }, () => "  ");

  switch (edit.kind) {
    case "row_above":
      // Never insert above the header — that would break the table shape.
      t.rows.splice(Math.max(1, row), 0, emptyRow());
      break;
    case "row_below":
      t.rows.splice(Math.max(1, row + 1), 0, emptyRow());
      break;
    case "delete_row":
      if (row === 0 || t.rows.length <= 2) return text;
      t.rows.splice(row, 1);
      break;
    case "add_col":
      t.align.splice(col + 1, 0, null);
      for (const r of t.rows) r.splice(col + 1, 0, "  ");
      break;
    case "delete_col":
      if (t.align.length <= 1) return text;
      t.align.splice(col, 1);
      for (const r of t.rows) r.splice(col, 1);
      break;
    case "align":
      t.align[col] = edit.align;
      break;
  }
  return serializeTable(t);
}
