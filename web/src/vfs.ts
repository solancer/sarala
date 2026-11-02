/**
 * The filesystem the app sees. The shared code works in path strings, so the
 * web build gives it paths and routes them by their first segment:
 *
 *   /Library/...        IndexedDB. Works in every browser; the default home.
 *   /Folders/<name>/... A real folder on this device (File System Access API).
 *   /Files/<id>/<name>  One real file, opened or saved through a picker.
 *   /Downloads/<name>   Write-only: the browser's download.
 *
 * Handles survive a reload in IndexedDB, but the browser may ask for permission
 * again and will only do so from a click; `needsAccess` tracks those.
 */
import { createSignal } from "solid-js";
import type { FileNode } from "../../src/platform";
import * as db from "./db";

export const LIBRARY = "/Library";
const FOLDERS = "/Folders";
const FILES = "/Files";
export const DOWNLOADS = "/Downloads";

const MARKDOWN = /\.(md|markdown|mdown|txt)$/i;
const MAX_DEPTH = 6;
const SKIP = (name: string) => name.startsWith(".") || name === "node_modules" || name === "target";

interface LibraryFile { path: string; data: Blob | ArrayBuffer; modified: number; created: number }

/** See `store`: older records and private windows hold plain bytes. */
const asBlob = (data: Blob | ArrayBuffer) => (data instanceof Blob ? data : new Blob([data]));
const sizeOf = (data: Blob | ArrayBuffer) => (data instanceof Blob ? data.size : data.byteLength);

/**
 * Blobs are the better fit: the browser keeps them on disk and a listing doesn't
 * pull their bytes into memory. WebKit can't store one in a private session,
 * though, where the transaction aborts, so fall back to bytes there.
 */
async function store(path: string, data: Blob, now: number) {
  const record = (payload: Blob | ArrayBuffer) => (cur: LibraryFile | undefined): LibraryFile =>
    ({ path, data: payload, modified: now, created: cur?.created ?? now });
  try {
    await db.update<LibraryFile>("files", path, record(data));
  } catch {
    await db.update<LibraryFile>("files", path, record(await data.arrayBuffer()));
  }
}

export interface Mount {
  id: string;
  kind: "dir" | "file";
  /** Unique among mounts: it is part of the path. */
  name: string;
  handle: FileSystemDirectoryHandle | FileSystemFileHandle;
}

export class NeedsAccess extends Error {
  constructor(readonly mount: Mount) {
    super(`Sarala needs your permission to open ${mount.name} again.`);
  }
}

const mounts = new Map<string, Mount>();
const rootOf = (m: Mount) => (m.kind === "dir" ? `${FOLDERS}/${m.name}` : `${FILES}/${m.id}/${m.name}`);

const [needsAccess, setNeedsAccess] = createSignal<Mount[]>([]);
export { needsAccess };

export const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export const dirName = (path: string) => path.slice(0, path.lastIndexOf("/"));

function mountFor(path: string): Mount | undefined {
  const [, ns, a, b] = path.split("/");
  if (`/${ns}` === FOLDERS) return mounts.get(`${FOLDERS}/${a}`);
  if (`/${ns}` === FILES) return mounts.get(`${FILES}/${a}/${b}`);
  return undefined;
}

export const isLibrary = (path: string) => path === LIBRARY || path.startsWith(`${LIBRARY}/`);
/** Single-file mounts have no folder around them to write into. */
export const isWritableDir = (dir: string) => isLibrary(dir) || mountFor(dir)?.kind === "dir";

/* ---------- permissions ---------- */

async function refreshAccess() {
  const stale: Mount[] = [];
  for (const m of mounts.values()) {
    if (m.kind === "dir" && (await m.handle.queryPermission({ mode: "readwrite" })) !== "granted") stale.push(m);
  }
  setNeedsAccess(stale);
}

/** Make sure a handle can be used. A user gesture is needed to ask, so the
 *  `quiet` paths (startup, background polling) only look. */
async function ensure(mount: Mount, mode: "read" | "readwrite", quiet: boolean) {
  const { handle } = mount;
  if ((await handle.queryPermission({ mode })) === "granted") return;
  if (quiet) throw new NeedsAccess(mount);
  try {
    if ((await handle.requestPermission({ mode })) === "granted") return;
  } catch { /* no user gesture to ask under */ }
  throw new NeedsAccess(mount);
}

export async function reconnect(mount: Mount): Promise<boolean> {
  try {
    if ((await mount.handle.requestPermission({ mode: "readwrite" })) !== "granted") return false;
  } catch { return false; }
  await refreshAccess();
  notifyTree();
  accessListeners.forEach((fn) => fn());
  return true;
}

export async function reconnectAll() {
  for (const m of needsAccess()) await reconnect(m);
}

const accessListeners = new Set<() => void>();
export function onAccessRestored(fn: () => void) { accessListeners.add(fn); }

/* ---------- mounts ---------- */

async function saveMount(kind: Mount["kind"], name: string, handle: Mount["handle"]): Promise<string> {
  for (const m of mounts.values()) {
    if (m.kind === kind && (await m.handle.isSameEntry(handle))) return rootOf(m);
  }
  let unique = name;
  for (let n = 2; kind === "dir" && mounts.has(`${FOLDERS}/${unique}`); n++) unique = `${name} (${n})`;
  const mount: Mount = { id: crypto.randomUUID().slice(0, 8), kind, name: unique, handle };
  mounts.set(rootOf(mount), mount);
  await db.put("handles", mount);
  return rootOf(mount);
}

export const mountFolder = (handle: FileSystemDirectoryHandle) => saveMount("dir", handle.name, handle);
export const mountFile = (handle: FileSystemFileHandle) => saveMount("file", handle.name, handle);

export async function unmount(mount: Mount) {
  mounts.delete(rootOf(mount));
  await db.del("handles", mount.id);
  await refreshAccess();
  notifyTree();
}

export const folders = () => [...mounts.values()].filter((m) => m.kind === "dir");
export const mountPath = rootOf;

async function dirHandleFor(mount: Mount, segments: string[], create: boolean) {
  let dir = mount.handle as FileSystemDirectoryHandle;
  for (const part of segments) dir = await dir.getDirectoryHandle(part, { create });
  return dir;
}

async function fileHandleFor(path: string, create: boolean, quiet: boolean): Promise<FileSystemFileHandle> {
  const mount = mountFor(path);
  if (!mount) throw new Error(`Can't reach ${path}`);
  await ensure(mount, create ? "readwrite" : "read", quiet);
  if (mount.kind === "file") return mount.handle as FileSystemFileHandle;
  const parts = path.slice(rootOf(mount).length + 1).split("/");
  const name = parts.pop()!;
  return (await dirHandleFor(mount, parts, create)).getFileHandle(name, { create });
}

/* ---------- reading ---------- */

export interface Stat { modified: number; created?: number; size: number }

export async function stat(path: string, quiet = true): Promise<Stat | null> {
  try {
    if (isLibrary(path)) {
      const rec = await db.get<LibraryFile>("files", path);
      return rec ? { modified: rec.modified, created: rec.created, size: sizeOf(rec.data) } : null;
    }
    const file = await (await fileHandleFor(path, false, quiet)).getFile();
    return { modified: file.lastModified, size: file.size };
  } catch (error) {
    if (error instanceof NeedsAccess) throw error;
    return null;
  }
}

export async function read(path: string, quiet = false): Promise<Blob> {
  if (isLibrary(path)) {
    const rec = await db.get<LibraryFile>("files", path);
    if (!rec) throw new Error(`${fileName(path)} no longer exists.`);
    return asBlob(rec.data);
  }
  return (await fileHandleFor(path, false, quiet)).getFile();
}

/** Whether a path resolves. Unknown (no permission yet) counts as present: a
 *  file shouldn't look deleted because the browser hasn't been asked. */
export async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)) !== null;
  } catch {
    return true;
  }
}

/* ---------- writing ---------- */

function download(name: string, data: Blob) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(data);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
}
export { download };

export async function write(path: string, data: Blob): Promise<void> {
  if (path.startsWith(`${DOWNLOADS}/`)) { download(fileName(path), data); return; }
  if (isLibrary(path)) {
    await store(path, data, Date.now());
    void askToPersist();
  } else {
    // createWritable writes to a swap file and replaces the target on close(),
    // so this has the desktop's temp-file-and-rename guarantee.
    const handle = await fileHandleFor(path, true, false);
    const out = await handle.createWritable();
    try {
      await out.write(data);
      await out.close();
    } catch (error) {
      await out.abort().catch(() => {});
      throw error;
    }
  }
  await settled(path, false);
}

export async function remove(path: string): Promise<void> {
  if (isLibrary(path)) {
    await db.del("files", path);
  } else {
    const mount = mountFor(path);
    if (!mount || mount.kind === "file") throw new Error("That file can't be deleted from here.");
    await ensure(mount, "readwrite", false);
    const parts = path.slice(rootOf(mount).length + 1).split("/");
    const name = parts.pop()!;
    await (await dirHandleFor(mount, parts, false)).removeEntry(name);
  }
  await settled(path, true);
}

export async function move(from: string, to: string): Promise<void> {
  if (isLibrary(from) && isLibrary(to)) {
    const rec = await db.get<LibraryFile>("files", from);
    if (!rec) throw new Error(`${fileName(from)} no longer exists.`);
    await db.batch("files", [{ del: from }, { put: { ...rec, path: to } }]);
    await settled(from, true);
    await settled(to, false);
    return;
  }
  await write(to, await read(from));
  await remove(from);
}

/** `name` in `dir`, numbered like the desktop's copy_asset if it is taken. */
export async function uniquePath(dir: string, name: string): Promise<string> {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = `${dir}/${name}`;
  for (let n = 1; await exists(candidate); n++) candidate = `${dir}/${stem}-${n}${ext}`;
  return candidate;
}

/** Bring the storage quota's eviction rules to bear on the first real save. */
let persistAsked = false;
async function askToPersist() {
  if (persistAsked) return;
  persistAsked = true;
  await navigator.storage?.persist?.().catch(() => false);
}

/* ---------- change tracking ---------- */

const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("sarala-vfs");
const watched = new Map<string, number>();
const externalListeners = new Set<(path: string, deleted: boolean) => void>();
const treeListeners = new Set<(tree: FileNode[]) => void>();
const fileListeners = new Set<(path: string) => void>();

/** Called after a file changed, for whatever caches it (the image cache). */
export function onFileChanged(fn: (path: string) => void) { fileListeners.add(fn); }

async function settled(path: string, deleted: boolean) {
  if (watched.has(path)) watched.set(path, deleted ? 0 : (await stat(path).catch(() => null))?.modified ?? 0);
  fileListeners.forEach((fn) => fn(path));
  notifyTree();
  channel?.postMessage({ path, deleted });
}

// Another tab wrote to the workspace: the same event a desktop watcher raises.
if (channel) channel.onmessage = (e: MessageEvent<{ path: string; deleted: boolean }>) => {
  const { path, deleted } = e.data;
  fileListeners.forEach((fn) => fn(path));
  notifyTree();
  if (watched.has(path)) {
    void stat(path).then((s) => { watched.set(path, s?.modified ?? 0); });
    externalListeners.forEach((fn) => fn(path, deleted));
  }
};

let treeTimer: ReturnType<typeof setTimeout> | undefined;
let lastTree = "";
function notifyTree() {
  clearTimeout(treeTimer);
  treeTimer = setTimeout(() => void emitTree(), 80);
}
async function emitTree() {
  const next = await tree();
  const key = JSON.stringify(next);
  if (key === lastTree) return;
  lastTree = key;
  treeListeners.forEach((fn) => fn(next));
}

export function onTree(fn: (tree: FileNode[]) => void) {
  treeListeners.add(fn);
  return () => { treeListeners.delete(fn); };
}
export function onExternal(fn: (path: string, deleted: boolean) => void) {
  externalListeners.add(fn);
  return () => { externalListeners.delete(fn); };
}

export async function watch(path: string) { watched.set(path, (await stat(path).catch(() => null))?.modified ?? 0); }
export function unwatch(path: string) { watched.delete(path); }

/**
 * Real files have no change events (FileSystemObserver isn't widely shipped),
 * so look when it matters: every few seconds while visible, and on coming back
 * to the tab, which is when an edit in another program would have happened.
 */
async function poll() {
  for (const [path, seen] of watched) {
    if (isLibrary(path)) continue;
    let now: Stat | null;
    try { now = await stat(path); } catch { continue; }
    if (!watched.has(path)) continue;
    if (!now) {
      if (seen !== 0) { watched.set(path, 0); externalListeners.forEach((fn) => fn(path, true)); }
    } else if (now.modified !== seen) {
      watched.set(path, now.modified);
      externalListeners.forEach((fn) => fn(path, false));
    }
  }
  if (mounts.size) await emitTree();
}

function startPolling() {
  const tick = () => { if (document.visibilityState === "visible") void poll(); };
  setInterval(tick, 4000);
  window.addEventListener("focus", tick);
  document.addEventListener("visibilitychange", tick);
}

/* ---------- listing ---------- */

interface TreeDir { node: FileNode; dirs: Map<string, TreeDir>; files: FileNode[] }

const byName = (a: FileNode, b: FileNode) => a.name.toLowerCase().localeCompare(b.name.toLowerCase());

function finish(dir: TreeDir): FileNode[] {
  const dirs = [...dir.dirs.values()].map((d) => ({ ...d.node, children: finish(d) })).sort(byName);
  return [...dirs, ...dir.files.sort(byName)];
}

async function libraryTree(): Promise<FileNode[]> {
  const root: TreeDir = { node: { name: "", path: LIBRARY, is_dir: true }, dirs: new Map(), files: [] };
  for (const f of await db.all<LibraryFile>("files")) {
    if (!MARKDOWN.test(f.path)) continue;
    const parts = f.path.slice(LIBRARY.length + 1).split("/");
    if (parts.some(SKIP)) continue;
    const name = parts.pop()!;
    let dir = root;
    for (const part of parts) {
      let next = dir.dirs.get(part);
      if (!next) {
        next = { node: { name: part, path: `${dir.node.path}/${part}`, is_dir: true }, dirs: new Map(), files: [] };
        dir.dirs.set(part, next);
      }
      dir = next;
    }
    dir.files.push({ name, path: f.path, is_dir: false, modified: f.modified, created: f.created });
  }
  return finish(root);
}

async function walk(dir: FileSystemDirectoryHandle, path: string, depth: number): Promise<FileNode[]> {
  const dirs: FileNode[] = [];
  const files: FileNode[] = [];
  for await (const entry of dir.values()) {
    if (SKIP(entry.name)) continue;
    const child = `${path}/${entry.name}`;
    if (entry.kind === "directory") {
      const children = depth < MAX_DEPTH ? await walk(entry as FileSystemDirectoryHandle, child, depth + 1) : [];
      if (children.length) dirs.push({ name: entry.name, path: child, is_dir: true, children });
    } else if (MARKDOWN.test(entry.name)) {
      const file = await (entry as FileSystemFileHandle).getFile();
      files.push({ name: entry.name, path: child, is_dir: false, modified: file.lastModified });
    }
  }
  return [...dirs.sort(byName), ...files.sort(byName)];
}

/** The workspace tree: the library's documents, then each folder on this device. */
export async function tree(): Promise<FileNode[]> {
  const nodes = await libraryTree();
  for (const m of folders()) {
    const path = rootOf(m);
    let children: FileNode[] = [];
    if ((await m.handle.queryPermission({ mode: "read" })) === "granted") {
      children = await walk(m.handle as FileSystemDirectoryHandle, path, 0).catch(() => []);
    }
    nodes.push({ name: m.name, path, is_dir: true, children });
  }
  return nodes;
}

/** Every folder a document can be saved into, for the save dialog. */
export async function writableFolders(): Promise<string[]> {
  const out = new Set<string>([LIBRARY]);
  for (const f of await db.keys("files")) {
    let dir = dirName(f as string);
    while (dir.length > LIBRARY.length) { out.add(dir); dir = dirName(dir); }
  }
  const visit = (nodes: FileNode[]) => { for (const n of nodes) if (n.is_dir) { out.add(n.path); visit(n.children ?? []); } };
  for (const m of folders()) {
    if ((await m.handle.queryPermission({ mode: "read" })) !== "granted") continue;
    out.add(rootOf(m));
    visit(await walk(m.handle as FileSystemDirectoryHandle, rootOf(m), 0).catch(() => []));
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}

/** Library files, whatever their type, for backups. */
export const libraryFiles = async () => (await db.all<LibraryFile>("files")).map((f) => ({ ...f, data: asBlob(f.data) }));
export async function clearLibrary() {
  const paths = (await db.keys("files")) as string[];
  await db.batch("files", paths.map((path) => ({ del: path })));
  paths.forEach((path) => fileListeners.forEach((fn) => fn(path)));
  notifyTree();
}

export async function initVfs() {
  for (const m of await db.all<Mount>("handles")) mounts.set(rootOf(m), m);
  await refreshAccess();
  startPolling();
}
