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
