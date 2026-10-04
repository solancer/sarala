/**
 * Turning an agent's edits to the working copy into reviewable proposals, and
 * checking them against the live document before they are applied.
 *
 * Pure: no store or DOM access, so it is unit-tested directly
 * (tests/ai.test.mjs). The session layer does the actual store mutation.
 */
import type { SnapshotBlock } from "./document";

export type ProposalStatus = "pending" | "accepted" | "rejected" | "stale";

export interface EditProposal {
  kind: "edit";
  id: string;
  /** Editor block ids covered, in document order. */
  blockIds: number[];
  original: string;
  /** New Markdown for the range; empty deletes it. */
  replacement: string;
  status: ProposalStatus;
  /** Block index when proposed: a label, and a hint for re-anchoring. */
  at?: number;
  /** Set on accept: the blocks it produced and the block before them, for Revert. */
  applied?: Applied;
}

export interface Applied {
  ids: number[];
  afterId: number | null;
}

export interface InsertProposal {
  kind: "insert";
  id: string;
  /** Insert after this block id; null inserts at the very start. */
  afterBlockId: number | null;
  replacement: string;
  status: ProposalStatus;
  /** Index of the block it goes after (-1 for the start), as for edits. */
  at?: number;
  /** Text of that block, saved so the insert can be re-anchored after a restart. */
  anchorText?: string;
  applied?: Applied;
}

export type Proposal = EditProposal | InsertProposal;

/** Line-ending and outer-whitespace insensitive comparison of Markdown. */
export const normalize = (s: string) => s.replace(/\r\n/g, "\n").trim();

/** Largest gap (rows × columns) compared with the exact quadratic LCS. */
const MAX_CELLS = 250_000;

/** Exact LCS of a[aLo..aHi) and b[bLo..bHi), appending matched index pairs. */
function lcsInto(a: string[], b: string[], aLo: number, aHi: number, bLo: number, bHi: number, out: [number, number][]) {
  const n = aHi - aLo;
  const m = bHi - bLo;
  const w = m + 1;
  const t = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[i * w + j] = a[aLo + i] === b[bLo + j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[aLo + i] === b[bLo + j]) out.push([aLo + i++, bLo + j++]);
    else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) i++;
    else j++;
  }
}

/**
 * Fallback anchors when no block is unique (heavily repeated content): pair the
 * k-th occurrence of a text in `a` with its k-th occurrence in `b`. The keys
 * are unique by construction and line repeated sections up in order.
 */
function occurrenceAnchors(a: string[], b: string[], aLo: number, aHi: number, bLo: number, bHi: number): [number, number][] {
  const seenB = new Map<string, number>();
  const posB = new Map<string, number>();
  for (let j = bLo; j < bHi; j++) {
    const k = seenB.get(b[j]) ?? 0;
    seenB.set(b[j], k + 1);
    posB.set(`${k}\u0000${b[j]}`, j);
  }
  const seenA = new Map<string, number>();
  const out: [number, number][] = [];
  for (let i = aLo; i < aHi; i++) {
    const k = seenA.get(a[i]) ?? 0;
    seenA.set(a[i], k + 1);
    const j = posB.get(`${k}\u0000${a[i]}`);
    if (j !== undefined) out.push([i, j]);
  }
  return out;
}

/**
 * Matched (unchanged) block pairs between a and b, in order. Common runs at
 * both ends are trimmed first; a gap small enough gets the exact LCS; a large
 * one is split at anchors (blocks that occur exactly once on each side, in
 * increasing order: patience diff; or, when nothing is unique, the k-th
 * occurrence on each side) and each piece is matched recursively. So
 * a long document with scattered edits still yields one proposal per edit,
 * in near-linear time.
 */
function matchInto(a: string[], b: string[], aLo: number, aHi: number, bLo: number, bHi: number, out: [number, number][]) {
  while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) out.push([aLo++, bLo++]);
  const tail: [number, number][] = [];
  while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) tail.push([--aHi, --bHi]);
  if (aLo < aHi && bLo < bHi) {
    if ((aHi - aLo) * (bHi - bLo) <= MAX_CELLS) {
      lcsInto(a, b, aLo, aHi, bLo, bHi, out);
    } else {
      const count = new Map<string, [number, number, number]>(); // [inA, inB, index in B]
      for (let i = aLo; i < aHi; i++) {
        const c = count.get(a[i]) ?? [0, 0, -1];
        c[0]++;
        count.set(a[i], c);
      }
      for (let j = bLo; j < bHi; j++) {
        const c = count.get(b[j]);
        if (c) { c[1]++; c[2] = j; }
      }
      let cand: [number, number][] = [];
      for (let i = aLo; i < aHi; i++) {
        const c = count.get(a[i])!;
        if (c[0] === 1 && c[1] === 1) cand.push([i, c[2]]);
      }
      if (!cand.length) cand = occurrenceAnchors(a, b, aLo, aHi, bLo, bHi);
      // Longest increasing run of B positions (patience sorting).
      const tails: number[] = [];
      const prev = new Int32Array(cand.length).fill(-1);
      for (let k = 0; k < cand.length; k++) {
        let lo = 0;
        let hi = tails.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (cand[tails[mid]][1] < cand[k][1]) lo = mid + 1;
          else hi = mid;
        }
        if (lo > 0) prev[k] = tails[lo - 1];
        tails[lo] = k;
      }
      const anchors: [number, number][] = [];
      for (let k = tails.length ? tails[tails.length - 1] : -1; k >= 0; k = prev[k]) anchors.push(cand[k]);
      anchors.reverse();
      if (anchors.length) {
        let pa = aLo;
        let pb = bLo;
        for (const [ai, bi] of anchors) {
          matchInto(a, b, pa, ai, pb, bi, out);
          out.push([ai, bi]);
          pa = ai + 1;
          pb = bi + 1;
        }
        matchInto(a, b, pa, aHi, pb, bHi, out);
      }
      // No anchors: nothing in the gap can be matched cheaply; it stays one change.
    }
  }
  for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]);
}

/**
 * Diff the blocks the agent was given against the blocks of its edited copy.
 * Unchanged blocks are matched (see `matchInto`); every run of changes between
 * two matches becomes one proposal: an edit (replace, or delete when nothing
 * replaces it) or an insert (new blocks where none were). A run with as many
 * blocks after as before is split into one edit per block.
 */
export function diffBlocks(before: readonly SnapshotBlock[], after: readonly string[], newId: () => string): Proposal[] {
  const a = before.map((b) => normalize(b.text));
  const b = after.map(normalize).filter((t, i, all) => t || all.length === 1);
  const n = a.length;
  const m = b.length;
  const matches: [number, number][] = [];
  matchInto(a, b, 0, n, 0, m, matches);
  matches.push([n, m]); // sentinel: flush the tail

  const out: Proposal[] = [];
  let pi = 0;
  let pj = 0;
  for (const [mi, mj] of matches) {
    if (mi > pi && mi - pi === mj - pj && mi - pi > 1) {
      // The same number of blocks on both sides (typically "edited each
      // paragraph"): one proposal per block, so each can be accepted alone.
      for (let k = 0; k < mi - pi; k++) {
        const old = before[pi + k];
        if (normalize(old.text) === b[pj + k]) continue;
        out.push({
          kind: "edit", id: newId(), blockIds: [old.id], original: old.text,
          replacement: b[pj + k], status: "pending", at: pi + k,
        });
      }
    } else if (mi > pi || mj > pj) {
      const olds = before.slice(pi, mi);
      const replacement = b.slice(pj, mj).join("\n\n");
      if (olds.length) {
        out.push({
          kind: "edit", id: newId(), blockIds: olds.map((x) => x.id),
          original: olds.map((x) => x.text).join("\n\n"), replacement, status: "pending", at: pi,
        });
      } else if (replacement) {
        out.push({
          kind: "insert", id: newId(), afterBlockId: pi > 0 ? before[pi - 1].id : null,
          replacement, status: "pending", at: pi - 1,
          anchorText: pi > 0 ? before[pi - 1].text : undefined,
        });
      }
    }
    pi = mi + 1;
    pj = mj + 1;
  }
  return out;
}

/**
 * Where a proposal applies in the live document, or why it can't.
 * An edit needs its blocks still present, contiguous, in order, and with the
 * same text it was proposed against.
 */
export type Resolution =
  | { ok: true; start: number; deleteCount: number }
  | { ok: false; reason: string };

export function resolveProposal(p: Proposal, blocks: readonly SnapshotBlock[]): Resolution {
  if (p.kind === "insert") {
    if (p.afterBlockId === null) return { ok: true, start: 0, deleteCount: 0 };
    const i = blocks.findIndex((b) => b.id === p.afterBlockId);
    return i < 0
      ? { ok: false, reason: "The block it was anchored to no longer exists." }
      : { ok: true, start: i + 1, deleteCount: 0 };
  }
  const first = blocks.findIndex((b) => b.id === p.blockIds[0]);
  if (first < 0) return { ok: false, reason: "The text it edits has changed since it was proposed." };
  for (let k = 0; k < p.blockIds.length; k++) {
    if (blocks[first + k]?.id !== p.blockIds[k]) {
      return { ok: false, reason: "The text it edits has changed since it was proposed." };
    }
  }
  const current = blocks.slice(first, first + p.blockIds.length).map((b) => b.text).join("\n\n");
  if (normalize(current) !== normalize(p.original)) {
    return { ok: false, reason: "The text it edits has changed since it was proposed." };
  }
  return { ok: true, start: first, deleteCount: p.blockIds.length };
}

/**
 * Point a saved proposal at the current blocks. Editor block ids don't survive
 * a restart, so a pending proposal is found again by its text: the run of
 * blocks matching `original` (or, for an insert, the block matching
 * `anchorText`), preferring the occurrence nearest its old position. Returns
 * null when the text is gone, meaning the proposal is out of date.
 */
export function reanchor(p: Proposal, blocks: readonly SnapshotBlock[]): Proposal | null {
  const near = (hits: number[]) =>
    hits.length ? hits.reduce((best, i) => (Math.abs(i - (p.at ?? 0)) < Math.abs(best - (p.at ?? 0)) ? i : best)) : -1;
  if (p.kind === "insert") {
    if (p.afterBlockId === null || p.anchorText === undefined) return { ...p, afterBlockId: null };
    const want = normalize(p.anchorText);
    const i = near(blocks.flatMap((b, k) => (normalize(b.text) === want ? [k] : [])));
    return i < 0 ? null : { ...p, afterBlockId: blocks[i].id, at: i };
  }
  const want = normalize(p.original);
  const n = Math.max(1, p.blockIds.length);
  const hits: number[] = [];
  for (let k = 0; k + n <= blocks.length; k++) {
    if (normalize(blocks.slice(k, k + n).map((b) => b.text).join("\n\n")) === want) hits.push(k);
  }
  const i = near(hits);
  return i < 0 ? null : { ...p, blockIds: blocks.slice(i, i + n).map((b) => b.id), at: i };
}

/**
 * Where an accepted proposal's result is now, so it can be reverted: its
 * blocks must still be there, contiguous and unedited. (A deletion produced
 * no blocks; it is found by the block that preceded it.)
 */
export function resolveRevert(p: Proposal, blocks: readonly SnapshotBlock[]): Resolution {
  const a = p.applied;
  if (p.status !== "accepted" || !a) return { ok: false, reason: "Nothing to revert." };
  const changed = { ok: false as const, reason: "The text has been edited since it was accepted." };
  let start: number;
  if (a.ids.length) {
    start = blocks.findIndex((b) => b.id === a.ids[0]);
    if (start < 0) return changed;
    for (let k = 0; k < a.ids.length; k++) if (blocks[start + k]?.id !== a.ids[k]) return changed;
    const now = blocks.slice(start, start + a.ids.length).map((b) => b.text).join("\n\n");
    if (normalize(now) !== normalize(p.replacement)) return changed;
  } else if (a.afterId === null) {
    start = 0;
  } else {
    const i = blocks.findIndex((b) => b.id === a.afterId);
    if (i < 0) return changed;
    start = i + 1;
  }
  return { ok: true, start, deleteCount: a.ids.length };
}

export interface Placed<T> {
  item: T;
  start: number;
  deleteCount: number;
}

/**
 * Plan applying several resolved proposals at once.
 *
 * Conflicts (edits whose ranges overlap an earlier one, or inserts that land
 * strictly inside an earlier edit's range, and vice versa) are returned
 * separately; the first proposal in list order wins. The rest are ordered so
 * each splice leaves the indices of those still to go untouched: highest
 * position first, an edit before an insert at the same position, and inserts
 * sharing a position in reverse so they end up in list order.
 */
export function planBatch<T>(placed: Placed<T>[]): { apply: Placed<T>[]; conflicts: T[] } {
  const kept: (Placed<T> & { order: number })[] = [];
  const conflicts: T[] = [];
  const clash = (a: Placed<T>, b: Placed<T>) => {
    const aEnd = a.start + a.deleteCount - 1;
    const bEnd = b.start + b.deleteCount - 1;
    if (a.deleteCount && b.deleteCount) return a.start <= bEnd && b.start <= aEnd;
    if (a.deleteCount) return b.start > a.start && b.start <= aEnd;
    if (b.deleteCount) return a.start > b.start && a.start <= bEnd;
    return false;
  };
  placed.forEach((p, order) => {
    if (kept.some((k) => clash(k, p))) conflicts.push(p.item);
    else kept.push({ ...p, order });
  });
  kept.sort((a, b) =>
    b.start - a.start
    || b.deleteCount - a.deleteCount
    || b.order - a.order);
  return { apply: kept.map(({ item, start, deleteCount }) => ({ item, start, deleteCount })), conflicts };
}
