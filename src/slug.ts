/**
 * Heading-anchor slugs, shared by the live renderer (markdown.ts) and the
 * standalone HTML/PDF exporter (export.ts) so an in-editor TOC link and an
 * exported TOC link resolve to the same id.
 */

/** Lowercase, strip punctuation, collapse whitespace to dashes. */
export function slugBase(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-") || "section"
  );
}

/** Slugify with de-duplication against a running `seen` set (export pass). */
export function slugify(text: string, seen: Set<string>): string {
  const base = slugBase(text);
  let id = base;
  let n = 1;
  while (seen.has(id)) id = `${base}-${++n}`;
  seen.add(id);
  return id;
}
