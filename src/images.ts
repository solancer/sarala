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
 * Pure image-src resolution (testable without Tauri):
 *  - remote/data/already-converted URLs pass through;
 *  - root-relative (`/x`) resolves against `typora-root-url` when set;
 *  - other relative paths resolve against the document's directory;
 *  - absolute file paths are used directly;
 * the resulting filesystem path is passed to `convert` (the asset protocol).
 * Returns the original src when it can't be resolved (no dir, etc.).
 */
export function resolveImagePath(src: string, ctx: ResolveCtx): string {
  const s = src.trim();
  if (!s || REMOTE.test(s) || s.startsWith("//")) return src;
  let abs: string;
  if (s.startsWith("/")) {
    abs = ctx.rootUrl ? joinPath(ctx.rootUrl, s.slice(1)) : s;
  } else if (isAbsolute(s)) {
    abs = s.replace(/\\/g, "/");
  } else {
    if (!ctx.dir) return src;
    abs = joinPath(ctx.dir, s);
  }
  return ctx.convert(abs);
}

/** Live resolver: gathers doc dir + front matter + Tauri's convertFileSrc. */
export function resolveImageSrc(src: string): string {
  if (!isTauri) return src;
  return resolveImagePath(src, {
    dir: docDir(),
    rootUrl: currentFrontMatter()["typora-root-url"],
    convert: (p) => {
      try {
        return convertFileSrc(p);
      } catch {
        return src;
      }
    },
  });
}

setImageResolver(resolveImageSrc);
