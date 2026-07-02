import { convertFileSrc } from "@tauri-apps/api/core";
import { doc } from "./store";
import { isTauri } from "./platform";
import { setImageResolver } from "./markdown";

/* ---------- document front matter ---------- */

/** Parse leading YAML front matter (simple `key: value` lines) from a doc. */
export function parseFrontMatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  if (!m) return out;
  for (const line of m[1].split("\n")) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** Front matter of the current document (its first block, if it is YAML). */
export function currentFrontMatter(): Record<string, string> {
  const first = doc.blocks[0]?.text ?? "";
  return first.startsWith("---\n") ? parseFrontMatter(first) : {};
}

/* ---------- path helpers ---------- */

/** Directory containing the current document, or null when unsaved. */
export function docDir(): string | null {
  const path = doc.filePath;
  if (!path) return null;
  const norm = path.replace(/\\/g, "/");
  const cut = norm.lastIndexOf("/");
  return cut > 0 ? norm.slice(0, cut) : null;
}

/** Current document's base name without extension (for ${filename}). */
export function docBaseName(): string {
  const path = doc.filePath ?? "Untitled.md";
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "Untitled.md";
  return name.replace(/\.[^.]+$/, "");
}

const isAbsolute = (p: string) => /^([A-Za-z]:[\\/]|\/)/.test(p);

/* ---------- image occurrences in block source ---------- */

export interface ImageRef {
  start: number;
  end: number;
  src: string;
  alt: string;
  kind: "md" | "html";
}

/** All image occurrences (markdown and HTML) in a block, in document order. */
export function findImages(text: string): ImageRef[] {
  const out: ImageRef[] = [];
  let m: RegExpExecArray | null;
  // Destination is either <…> (may contain spaces) or a bare run of non-space
  // characters, optionally followed by a "title".
  const md = /!\[([^\]\n]*)\]\(\s*(?:<([^>\n]*)>|([^)\s]+))(?:\s+"[^"]*")?\s*\)/g;
  while ((m = md.exec(text))) {
    out.push({ start: m.index, end: m.index + m[0].length, alt: m[1], src: m[2] ?? m[3], kind: "md" });
  }
  const html = /<img\s[^>]*?\/?>/gi;
  while ((m = html.exec(text))) {
    const tag = m[0];
    out.push({
      start: m.index,
      end: m.index + tag.length,
      src: /\bsrc\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "",
      alt: /\balt\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "",
      kind: "html",
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Join a base dir and a relative path, normalizing `.` and `..`. */
function joinPath(base: string, rel: string): string {
  const combined = base.replace(/\\/g, "/").replace(/\/+$/, "") + "/" + rel.replace(/\\/g, "/");
  const out: string[] = [];
  for (const seg of combined.split("/")) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(seg);
  }
  return out.join("/");
}

/* ---------- resolver ---------- */

const REMOTE = /^(https?:|data:|blob:|mailto:|tauri:|asset:|file:)/i;

interface ResolveCtx {
  dir: string | null;
  rootUrl?: string;
  convert: (absPath: string) => string;
}

/**
 * Pure absolute-path resolution for a markdown image src (testable):
 *  - remote/data URLs → null (no local file);
 *  - root-relative (`/x`) → against the `image-root-url` front matter when set;
 *  - other relative paths → against the document's directory;
 *  - absolute file paths → used directly.
 * Returns null when the src has no local file (remote, or no doc dir).
 */
export function toAbsImagePath(src: string, ctx: Omit<ResolveCtx, "convert">): string | null {
  const s = src.trim();
  if (!s || REMOTE.test(s) || s.startsWith("//")) return null;
  if (s.startsWith("/")) return ctx.rootUrl ? joinPath(ctx.rootUrl, s.slice(1)) : s;
  if (isAbsolute(s)) return s.replace(/\\/g, "/");
  return ctx.dir ? joinPath(ctx.dir, s) : null;
}

/**
 * Pure image-src resolution: maps a src to a loadable URL via `convert` (the
 * asset protocol), passing remote/data URLs and unresolvable srcs through.
 */
export function resolveImagePath(src: string, ctx: ResolveCtx): string {
  const abs = toAbsImagePath(src, ctx);
  return abs == null ? src : ctx.convert(abs);
}

/** Live resolver: gathers doc dir + front matter + Tauri's convertFileSrc. */
export function resolveImageSrc(src: string): string {
  if (!isTauri) return src;
  return resolveImagePath(src, {
    dir: docDir(),
    rootUrl: currentFrontMatter()["image-root-url"],
    convert: (p) => {
      try {
        return convertFileSrc(p);
      } catch {
        return src;
      }
    },
  });
}

/** Absolute filesystem path of an image src, for file operations. Null if remote. */
export function imageFsPath(src: string): string | null {
  return toAbsImagePath(src, { dir: docDir(), rootUrl: currentFrontMatter()["image-root-url"] });
}

setImageResolver(resolveImageSrc);
