/**
 * The document as the agent sees it: a working copy `document.md` whose text
 * is the blocks joined the same way the editor saves them. A `Snapshot`
 * records which editor block id each block was when the copy was written, so
 * the agent's edits can be mapped back to blocks that may since have moved.
 */

export interface SnapshotBlock {
  id: number;
  text: string;
}

export interface Snapshot {
  blocks: SnapshotBlock[];
}

export function takeSnapshot(blocks: readonly SnapshotBlock[]): Snapshot {
  return { blocks: blocks.map((b) => ({ id: b.id, text: b.text })) };
}

/** Same join as `joinBlocks` in markdown.ts (kept dependency-free for tests). */
export function snapshotText(snap: Snapshot): string {
  return snap.blocks.map((b) => b.text).join("\n\n") + "\n";
}

/** 1-based first/last line of each block in `snapshotText`. */
export function blockLines(snap: Snapshot): { start: number; end: number }[] {
  let line = 1;
  return snap.blocks.map((b) => {
    const start = line;
    const end = start + b.text.split("\n").length - 1;
    line = end + 2; // the blank separator line
    return { start, end };
  });
}

/** A piece of the document the user attached to their message. */
export interface Reference {
  id: string;
  blockIds: number[];
  quote: string;
}

/** References as prompt text, located by line numbers in document.md. */
export function serializeReferences(refs: readonly Reference[], snap: Snapshot): string {
  const lines = blockLines(snap);
  const indexOf = new Map(snap.blocks.map((b, i) => [b.id, i]));
  return refs
    .map((r) => {
      const idx = r.blockIds.map((id) => indexOf.get(id)).filter((i): i is number => i !== undefined);
      if (!idx.length) return "";
      const lo = lines[Math.min(...idx)].start;
      const hi = lines[Math.max(...idx)].end;
      const where = lo === hi ? `line ${lo}` : `lines ${lo}-${hi}`;
      return `<selection location="${where} of document.md">\n${r.quote}\n</selection>`;
    })
    .filter(Boolean)
    .join("\n");
}

/** Short label for a reference chip. */
export function referenceLabel(r: Reference, max = 48): string {
  const flat = r.quote.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}
