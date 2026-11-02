/**
 * Shared search-pattern construction for the find bar and folder search.
 * Pure and unit-tested; the Rust `search_in_folder` command mirrors this same
 * escape / whole-word / case-fold logic on the backend.
 */
export interface SearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/**
 * Build a global RegExp from a query + options, or null for an empty query or
 * an invalid user-supplied regex. Plain queries are escaped; whole-word wraps
 * the pattern in word boundaries; case-insensitive unless caseSensitive is set.
 */
export function buildSearchRegex(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null;
  let src = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (opts.wholeWord) src = `\\b(?:${src})\\b`;
  try {
    return new RegExp(src, "g" + (opts.caseSensitive ? "" : "i"));
  } catch {
    return null;
  }
}

/** Result limits, the same as `search_in_folder` in src-tauri/src/main.rs. */
export const MAX_PER_FILE = 50;
export const MAX_TOTAL = 2000;

export interface LineMatch {
  line: number;
  text: string;
}

/** The lines of `text` the pattern matches, as a folder search reports them. */
export function matchLines(text: string, re: RegExp, limit = MAX_PER_FILE): LineMatch[] {
  const out: LineMatch[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length && out.length < limit; i++) {
    if (lines[i].match(re)) out.push({ line: i + 1, text: [...lines[i].trim()].slice(0, 200).join("") });
  }
  return out;
}

/**
 * Where the `hit`th matching line sits in a document's blocks: its block, and
 * how many matches come before it there. Counting matching lines rather than
 * line numbers survives the blank lines a document normalises on open.
 */
export function locateHit(blocks: string[], hit: number, re: RegExp): { block: number; ordinal: number } | null {
  let seen = 0;
  for (let block = 0; block < blocks.length; block++) {
    let ordinal = 0;
    for (const line of blocks[block].split("\n")) {
      const found = line.match(re);
      if (!found) continue;
      if (seen++ === hit) return { block, ordinal };
      ordinal += found.filter(Boolean).length;
    }
  }
  return null;
}
