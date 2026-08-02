/**
 * Link occurrences in a block's Markdown source, and the edits the hover
 * helper applies to them.
 *
 * Two shapes render as an anchor: an explicit `[label](url)` and a bare URL
 * that the autolink extension picks up. They are told apart because the edits
 * differ — a bare URL *is* its own label, so retargeting it rewrites the visible
 * text, and "remove link" has nothing to unwrap.
 *
 * Matching a hovered anchor back to its source is done by href rather than by
 * ordinal (the trick `findImages` uses): the renderer emits anchors the source
 * has no link for — footnote references, `[TOC]` entries — so counting them
 * would drift and an edit would land on the wrong occurrence.
 */

import { doc, updateBlock } from "./store";
import { docDir, joinPath } from "./images";

export interface LinkRef {
  /** First character of the whole occurrence. */
  start: number;
  /** One past the last. */
  end: number;
  label: string;
  url: string;
  /** `bare` is an autolinked URL with no brackets around it. */
  kind: "md" | "bare";
}

export interface LinkTarget extends LinkRef {
  blockId: number;
}

/** `[label](url "title")`, but not `![alt](src)` — an image is not a link. */
const MD_LINK = /(!?)\[([^\]\n]+)\]\(\s*(?:<([^>\n]*)>|([^)\s]*))(?:\s+"[^"]*")?\s*\)/g;
const BARE_URL = /https?:\/\/[^\s<>)"'\]]+/g;

/**
 * Every link in a block, in document order. Bare URLs already inside a
 * markdown link's span are skipped so a single link is never reported twice.
 */
export function findLinks(text: string): LinkRef[] {
  const out: LinkRef[] = [];
  const claimed: [number, number][] = [];

  let m: RegExpExecArray | null;
  MD_LINK.lastIndex = 0;
  while ((m = MD_LINK.exec(text)) !== null) {
    const end = m.index + m[0].length;
    // Images share the bracket syntax; claim their span so the URL inside is
    // not then reported as a bare link, but do not offer them as links.
    claimed.push([m.index, end]);
    if (m[1] === "!") continue;
    out.push({
      start: m.index,
      end,
      label: m[2],
      url: m[3] ?? m[4] ?? "",
      kind: "md",
    });
  }

  BARE_URL.lastIndex = 0;
  while ((m = BARE_URL.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    if (claimed.some(([a, b]) => start < b && end > a)) continue;
    out.push({ start, end, label: m[0], url: m[0], kind: "bare" });
  }

  return out.sort((a, b) => a.start - b.start);
}

/**
 * The link a rendered anchor came from. `nth` counts anchors carrying the same
 * href, so repeated links to one URL still resolve to the right occurrence.
 */
export function linkForHref(text: string, href: string, nth: number): LinkRef | null {
  const matches = findLinks(text).filter((l) => l.url === href);
  return matches[nth] ?? null;
}

/** Source text for a link occurrence. */
export function linkMarkup(label: string, url: string, kind: "md" | "bare"): string {
  // A bare URL is its own label; keeping the bracket form would change what the
  // reader sees, so retargeting one just swaps the URL text.
  if (kind === "bare") return url;
  return `[${label}](${url})`;
}

const blockIndexOf = (id: number) => doc.blocks.findIndex((b) => b.id === id);

function rewrite(t: LinkTarget, replacement: string) {
  const i = blockIndexOf(t.blockId);
  if (i < 0) return;
  const text = doc.blocks[i].text;
  if (t.start > text.length) return;
  updateBlock(i, text.slice(0, t.start) + replacement + text.slice(t.end));
}

/** Point the link somewhere else, keeping its visible label. */
export function setLinkUrl(t: LinkTarget, url: string) {
  const next = url.trim();
  if (!next || next === t.url) return;
  rewrite(t, linkMarkup(t.label, next, t.kind));
}

/* ---------- following a link ---------- */

/** Anything carrying a scheme is the OS's business, not ours. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/**
 * `C:\docs\README.md` satisfies HAS_SCHEME as well, so a Windows drive letter
 * has to be ruled out before the scheme test — otherwise every absolute path on
 * Windows is handed to the OS as a URL and no local document ever opens.
 */
const WIN_DRIVE = /^[A-Za-z]:[\\/]/;
/** Documents Sarala can open itself, matching what the file tree lists. */
const OPENABLE = /\.(md|markdown|mdown|txt)$/i;

export type LinkDestination =
  | { kind: "external"; url: string }
  /** An in-document `#heading` jump. */
  | { kind: "anchor"; id: string }
  /** A sibling document Sarala can open in the editor. */
  | { kind: "document"; path: string }
  /** A local file that is not a document — hand it to the OS. */
  | { kind: "file"; path: string }
  | { kind: "unknown" };

/**
 * Where a link should take you.
 *
 * The reason this exists: a relative link to a sibling document (`RELEASING.md`
 * from a README) used to be handed straight to the OS opener, which receives a
 * schemeless relative path, has no idea what directory it is relative to, and
 * silently does nothing. Local paths have to be resolved against the open
 * document's folder first, and markdown ones opened in the editor rather than
 * thrown at the desktop.
 */
export function linkDestination(href: string, dir = docDir()): LinkDestination {
  const raw = href.trim();
  if (!raw) return { kind: "unknown" };
  if (raw.startsWith("#")) return { kind: "anchor", id: raw.slice(1) };
  if (!WIN_DRIVE.test(raw) && HAS_SCHEME.test(raw)) return { kind: "external", url: raw };

  // Strip a fragment/query before touching the filesystem.
  const path = raw.split(/[?#]/)[0];
  if (!path) return { kind: "unknown" };
  const abs = WIN_DRIVE.test(path) || path.startsWith("/")
    ? path.replace(/\\/g, "/")
    : dir
      ? joinPath(dir, path)
      : null;
  if (!abs) return { kind: "unknown" };
  return OPENABLE.test(abs) ? { kind: "document", path: abs } : { kind: "file", path: abs };
}

/** Unwrap to plain text. A bare URL has no wrapper, so its text stays. */
export function removeLink(t: LinkTarget) {
  rewrite(t, t.kind === "bare" ? t.url : t.label);
}
