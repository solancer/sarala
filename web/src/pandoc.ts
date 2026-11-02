/**
 * Import and export through pandoc.wasm, the project's official build. As on
 * the desktop it is fetched only when first needed; once cached it needs no
 * network, and the documents it converts never leave the browser.
 */
import { findImages, toAbsImagePath } from "../../src/images";
import { dirName, download, fileName, LIBRARY, read, uniquePath, write } from "./vfs";

const VERSION = "3.9";
const CACHE = `sarala-pandoc-${VERSION}`;
const url = () => new URL(`${import.meta.env.BASE_URL}pandoc/pandoc.bin`, location.href).href;

/** Held in memory where Cache Storage is unavailable (some private windows). */
let memoryCopy: Blob | null = null;

async function cached(): Promise<Blob | null> {
  if (memoryCopy) return memoryCopy;
  try {
    const hit = await (await caches.open(CACHE)).match(url());
    return hit ? await hit.blob() : null;
  } catch {
    return null;
  }
}

export const hasPandoc = async () => (await cached()) !== null;

export async function downloadPandoc(onProgress: (phase: "download" | "verify", percent: number | null) => void): Promise<void> {
  const response = await fetch(url());
  if (!response.ok || !response.body) throw new Error(`Could not download Pandoc (${response.status}).`);
  const total = Number(response.headers.get("content-length")) || 0;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const reader = response.body.getReader();
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress("download", total ? Math.min(100, Math.round((received / total) * 100)) : null);
  }
  onProgress("verify", null);
  const blob = new Blob(chunks);
  try {
    const cache = await caches.open(CACHE);
    await cache.put(url(), new Response(blob));
    for (const name of await caches.keys()) {
      if (name.startsWith("sarala-pandoc-") && name !== CACHE) await caches.delete(name);
    }
  } catch {
    memoryCopy = blob;
  }
}

/* ---------- the worker ---------- */

interface Reply {
  id: number; error?: string; stdout: string; stderr: string;
  files: Record<string, Blob>; media: Record<string, Blob>;
}

let worker: Worker | null = null;
let idle: ReturnType<typeof setTimeout> | undefined;
let nextId = 0;
const waiting = new Map<number, { resolve(r: Reply): void; reject(e: Error): void }>();

function stopWorker() {
  worker?.terminate();
  worker = null;
}

function ensureWorker(): Worker {
  clearTimeout(idle);
  if (worker) return worker;
  worker = new Worker(new URL("./pandoc.worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = (e: MessageEvent<Reply>) => {
    const entry = waiting.get(e.data.id);
    if (!entry) return;
    waiting.delete(e.data.id);
    if (e.data.error) entry.reject(new Error(e.data.error));
    else entry.resolve(e.data);
    // The heap runs to hundreds of megabytes: give it back when not in use.
    if (!waiting.size) idle = setTimeout(stopWorker, 60_000);
  };
  worker.onerror = (e) => {
    for (const entry of waiting.values()) entry.reject(new Error(e.message || "Pandoc stopped unexpectedly."));
    waiting.clear();
    stopWorker();
  };
  return worker;
}

async function convert(options: Record<string, unknown>, stdin: string | null, files: Record<string, Blob | string>): Promise<Reply> {
  const binary = await cached();
  if (!binary) throw new Error("Pandoc isn't downloaded.");
  const w = ensureWorker();
  const id = nextId++;
  return new Promise<Reply>((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, binary, options, stdin, files });
  });
}

/* ---------- import ---------- */

const FORMATS: Record<string, string> = {
  docx: "docx", epub: "epub", rst: "rst", org: "org", odt: "odt", html: "html", tex: "latex",
};
let pendingImport: File | null = null;
export const holdImport = (file: File) => { pendingImport = file; };

export async function pandocImport(): Promise<string> {
  const file = pendingImport;
  pendingImport = null;
  if (!file) throw new Error("No file was chosen.");
  const ext = file.name.slice(file.name.lastIndexOf(".") + 1).toLowerCase();
  const from = FORMATS[ext];
  if (!from) throw new Error(`Sarala can't import .${ext} files.`);
  const input = `input.${ext}`;
  const result = await convert(
    { from, to: "gfm", wrap: "none", "input-files": [input], "extract-media": "media" },
    null,
    { [input]: file },
  );
  if (!result.stdout && result.stderr) throw new Error(result.stderr);
  let markdown = result.stdout;
  // Unlike the desktop importer, keep embedded images: they go in the library
  // beside where the document will most likely be saved.
  const media = Object.entries(result.media);
  if (media.length) {
    const stem = file.name.replace(/\.[^.]+$/, "");
    for (const [name, blob] of media) {
      const stored = await uniquePath(`${LIBRARY}/${stem} files`, fileName(name));
      await write(stored, blob);
      const dest = /\s/.test(stored) ? `<${stored}>` : stored;
      markdown = markdown.split(`](${name})`).join(`](${dest})`).split(`src="${name}"`).join(`src="${stored}"`);
    }
  }
  return markdown;
}

/* ---------- export ---------- */

/** Pandoc's API takes a defaults object, not a command line. */
function optionsFrom(flags: string[]): Record<string, unknown> {
  const names: Record<string, string> = { toc: "table-of-contents" };
  const out: Record<string, unknown> = {};
  for (const flag of flags) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(flag);
    if (!m) continue;
    const key = names[m[1]] ?? m[1];
    out[key] = m[2] === undefined ? true : /^\d+$/.test(m[2]) ? Number(m[2]) : m[2];
  }
  // Pandoc 3 folded this into split-level.
  delete out["epub-chapter-level"];
  return out;
}

/** Give Pandoc the document's local images under flat names of their own. */
async function withImages(markdown: string, baseDir: string | null) {
  const files: Record<string, Blob> = {};
  let out = "";
  let at = 0;
  let n = 0;
  for (const image of findImages(markdown)) {
    const path = toAbsImagePath(image.src, { dir: baseDir });
    if (!path || !path.startsWith("/")) continue;
    try {
      const blob = await read(path, true);
      const name = `image${n++}${/\.[a-z0-9]+$/i.exec(fileName(path))?.[0] ?? ""}`;
      files[name] = blob;
      const piece = markdown.slice(image.start, image.end);
      out += markdown.slice(at, image.start) + piece.replace(image.src, name);
      at = image.end;
    } catch { /* missing image: Pandoc warns and leaves the reference */ }
  }
  return { markdown: out + markdown.slice(at), files };
}

const stripFrontMatter = (md: string) => md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");

export async function pandocExport(markdown: string, output: string, format: string, flags: string[], baseDir: string | null) {
  const prepared = await withImages(stripFrontMatter(markdown), baseDir);
  const target = `output.${format}`;
  const result = await convert(
    { from: "gfm", to: format, "input-files": ["input.md"], "output-file": target, ...optionsFrom(flags) },
    null,
    { "input.md": prepared.markdown, ...prepared.files },
  );
  const blob = result.files[target];
  if (!blob) throw new Error(result.stderr || "Pandoc produced no output.");
  if (dirName(output) === "/Downloads") download(fileName(output), blob);
  else await write(output, blob);
}
