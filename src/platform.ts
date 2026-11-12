export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  /** Epoch ms, files only. Absent where the OS doesn't record it (creation
   *  time on some Linux filesystems). */
  modified?: number;
  created?: number;
  children?: FileNode[];
}

/** Fresh times for a listed file that was saved, from the tree watcher. */
export interface FileTimes {
  path: string;
  modified?: number | null;
  created?: number | null;
}

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * What the web build supplies in place of the Rust commands. The dependency
 * points one way: `web/` imports this module and installs itself before the app
 * loads, so the desktop bundle holds no web code. Paths are virtual (see
 * web/src/vfs.ts), which is why the commands above this layer need no changes.
 */
export interface WebPlatform {
  version: string;
  pickMarkdownFile(): Promise<string | null>;
  /** Choose an existing destination folder. */
  pickFolder(): Promise<string | null>;
  /** Add a folder from this device to the workspace. */
  addFolder(): Promise<string | null>;
  pickSavePath(defaultName: string, title?: string): Promise<string | null>;
  /** Exports go to the browser's downloads, not the workspace. */
  exportPath(defaultName: string): string;
  pickImportFile(): Promise<string | null>;
  pickImageFile(): Promise<string | null>;
  pathExists(path: string): Promise<boolean>;
  readFileEncoded(path: string): Promise<EncodedDoc>;
  reopenWithEncoding(path: string, label: string): Promise<EncodedDoc>;
  writeTextFile(path: string, contents: string, encoding: string, bom: boolean): Promise<void>;
  watchFile(path: string): Promise<void>;
  unwatchFile(path: string): void;
  onExternalChange(fn: (path: string, deleted: boolean) => void): () => void;
  watchTree(path: string): Promise<FileNode[]>;
  onTreeChange(fn: (root: string, tree: FileNode[]) => void): () => void;
  searchInFolder(root: string, query: string, opts: FolderSearchOptions): Promise<FolderSearchHit[]>;
  /** Added folders a search can't read until the user allows it again. */
  blockedFolders(): string[];
  reconnectFolders(): Promise<void>;
  copyAsset(src: string, docDir: string, subfolder: string): Promise<string>;
  renameFile(from: string, to: string): Promise<void>;
  copyFileTo(src: string, destDir: string): Promise<string>;
  deleteFile(path: string): Promise<void>;
  hasPandoc(): Promise<boolean>;
  downloadPandoc(onProgress: (phase: "download" | "verify", percent: number | null) => void): Promise<void>;
  pandocImport(path: string): Promise<string>;
  pandocExport(markdown: string, output: string, format: string, flags: string[], baseDir: string | null): Promise<void>;
  exportPdf(html: string, output: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  /** A loadable URL for a workspace image. Synchronous, because rendering is;
   *  an image not read yet loads in the background and re-renders its block. */
  imageUrl(path: string): string;
  /** Load images up front, for an export that renders once and can't re-render. */
  preloadImages(paths: string[]): Promise<void>;
  /** Replace blob: image URLs with data: URIs, so an export stands alone. */
  inlineImages(root: HTMLElement): Promise<void>;
  /** A pasted or dropped image: store it beside the document; returns its path. */
  storeImage(file: File): Promise<string>;
  listFonts(): Promise<string[]>;
  fontFaces(family: string): Promise<{ weight: number; italic: boolean; format: string; b64: string }[]>;
  checkForUpdates(silent: boolean): Promise<void>;
  /** Commands with no meaning in a browser: dropped from menus and palette. */
  hidden(id: string): boolean;
  /** Whether a shortcut reaches the page here, so it's worth showing. A browser
   *  tab keeps some for itself. */
  accelWorks(accel: string): boolean;
  /** The document bar's pieces, by where they go in the app. Set once the app's
   *  modules may load, because they read the platform as they evaluate. */
  toolbar?: (slot: "start" | "afterTabs" | "actions" | "end" | "root") => unknown;
  commands: Record<string, () => void | Promise<void>>;
  /** Extra menu items, added to a top-level menu by its label. */
  menuItems: Record<string, { id: string; label: string }[]>;
  /** Boots the workspace; called once from App's onMount. */
  start(): void;
  /** Dialogs and banners, mounted at the root of the app. */
  overlays(): unknown;
  /** The Storage page in Settings. */
  storagePanel(): unknown;
}

export let web: WebPlatform | null = null;
/** Whether a shortcut is worth showing: some never reach a page in a tab. */
export const accelWorks = (accel: string) => web?.accelWorks(accel) ?? true;
export let isWeb = false;
export function installWebPlatform(platform: WebPlatform) {
  web = platform;
  isWeb = true;
}

// Replaced at build time by Vite's `define`. True only in the Flathub build
// (SARALA_FLATPAK=1); Flatpak delivers its own updates, so the in-app updater is
// suppressed there (see updater.ts).
declare const __SARALA_FLATPAK__: boolean;
export const isFlatpak =
  typeof __SARALA_FLATPAK__ !== "undefined" && __SARALA_FLATPAK__ === true;

// macOS keeps its native global menu bar; every other platform (and the browser
// dev build) uses the in-app menubar, so this gates which menu the UI renders.
export const isMac =
  typeof navigator !== "undefined" &&
  /Mac/i.test(navigator.userAgent || (navigator as { platform?: string }).platform || "");

async function tauriCore() {
  return await import("@tauri-apps/api/core");
}

export async function readOmarchyColors(): Promise<string | null> {
  if (!isTauri) return null;
  const { invoke } = await tauriCore();
  return invoke<string | null>("read_omarchy_colors");
}

export async function pickMarkdownFile(): Promise<string | null> {
  if (web) return web.pickMarkdownFile();
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const sel = await open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
  });
  return typeof sel === "string" ? sel : null;
}

export async function pickFolder(): Promise<string | null> {
  if (web) return web.pickFolder();
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const sel = await open({ directory: true, multiple: false });
  return typeof sel === "string" ? sel : null;
}

export async function pickSavePath(defaultName: string, title?: string): Promise<string | null> {
  if (web) return web.pickSavePath(defaultName, title);
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return await save({ defaultPath: defaultName });
}

/** Where an export goes: a chosen path, or the browser's downloads on the web. */
export async function pickExportPath(defaultName: string): Promise<string | null> {
  return web ? web.exportPath(defaultName) : pickSavePath(defaultName);
}

/**
 * Whether a path still resolves on disk. In the browser build there is no
 * filesystem, so nothing is reported missing — marking every Recent entry dead
 * in `pnpm dev` would be worse than not checking at all.
 */
export async function pathExists(path: string): Promise<boolean> {
  if (web) return web.pathExists(path);
  if (!isTauri) return true;
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<boolean>("path_exists", { path }).catch(() => true);
}

export async function readTextFile(path: string): Promise<string> {
  if (web) return (await web.readFileEncoded(path)).content;
  const { invoke } = await tauriCore();
  return await invoke<string>("read_file", { path });
}

export interface EncodedDoc {
  content: string;
  encoding: string;
  hadBom: boolean;
  /** Decoding hit replacement chars — auto-detection may have guessed wrong. */
  lossy: boolean;
}

// Rust serializes had_bom; normalise to camelCase for the rest of the app.
interface RawEncodedDoc {
  content: string;
  encoding: string;
  had_bom: boolean;
  lossy: boolean;
}
const normEncoded = (d: RawEncodedDoc): EncodedDoc => ({
  content: d.content,
  encoding: d.encoding,
  hadBom: d.had_bom,
  lossy: d.lossy,
});

/** Read a file with encoding auto-detection (BOM sniff + chardetng). */
export async function readFileEncoded(path: string): Promise<EncodedDoc> {
  if (web) return web.readFileEncoded(path);
  const { invoke } = await tauriCore();
  return normEncoded(await invoke<RawEncodedDoc>("read_file_encoded", { path }));
}

/** Re-decode a file with an explicit encoding label (the encoding picker). */
export async function reopenWithEncoding(path: string, label: string): Promise<EncodedDoc> {
  if (web) return web.reopenWithEncoding(path, label);
  const { invoke } = await tauriCore();
  return normEncoded(await invoke<RawEncodedDoc>("reopen_with_encoding", { path, label }));
}

export async function writeTextFile(
  path: string,
  contents: string,
  encoding = "UTF-8",
  bom = false,
): Promise<void> {
  if (web) return web.writeTextFile(path, contents, encoding, bom);
  if (!isTauri) {
    const blob = new Blob([contents], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = path.split("/").pop() || "document.md";
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  const { invoke } = await tauriCore();
  await invoke("save_file", { path, contents, encoding, bom });
}

/** Start watching a file for external changes (no-op in browser). */
export async function watchFile(path: string): Promise<void> {
  if (web) return web.watchFile(path);
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("watch_file", { path }).catch(() => {});
}

export async function unwatchFile(path: string): Promise<void> {
  if (web) return web.unwatchFile(path);
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("unwatch_file", { path }).catch(() => {});
}

/** Listen for the Rust watcher's external-change/-removed events. */
export async function onExternalChange(
  fn: (path: string, deleted: boolean) => void,
): Promise<() => void> {
  if (web) return web.onExternalChange(fn);
  if (!isTauri) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  const a = await listen<{ path: string }>("external-change", (e) => fn(e.payload.path, false));
  const b = await listen<{ path: string }>("external-removed", (e) => fn(e.payload.path, true));
  return () => { a(); b(); };
}

export interface ShadowSession {
  path: string;
  content: string;
  savedAt: number;
  encoding: string;
  hadBom: boolean;
  /** Set when the user answered "No" to restoring it. Kept, not deleted, so a
   *  wrong click can't destroy unsaved work: opening the file still offers it. */
  declinedAt?: number;
}

export async function writeShadow(key: string, data: ShadowSession): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("write_shadow", { key, data }).catch(() => {});
}

export async function clearShadow(key: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("clear_shadow", { key }).catch(() => {});
}

export async function listShadows(): Promise<ShadowSession[]> {
  if (!isTauri) return [];
  const { invoke } = await tauriCore();
  return await invoke<ShadowSession[]>("list_shadows").catch(() => []);
}

/** List a folder's markdown tree and keep it watched; calling again with the
 *  same folder just re-lists, a different one replaces this window's watch. */
export async function watchTree(path: string): Promise<FileNode[]> {
  if (web) return web.watchTree(path);
  const { invoke } = await tauriCore();
  return await invoke<FileNode[]>("watch_tree", { path });
}

/** Listen for the watched folder's tree changing on disk. */
export async function onTreeChange(
  fn: (root: string, tree: FileNode[]) => void,
): Promise<() => void> {
  if (web) return web.onTreeChange(fn);
  if (!isTauri) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return await getCurrentWebviewWindow().listen<{ root: string; tree: FileNode[] }>(
    "tree-changed", (e) => fn(e.payload.root, e.payload.tree),
  );
}

/** Listen for listed files being saved (shape unchanged): just their new times. */
export async function onTreeTouch(
  fn: (root: string, files: FileTimes[]) => void,
): Promise<() => void> {
  if (!isTauri) return () => {};
  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return await getCurrentWebviewWindow().listen<{ root: string; files: FileTimes[] }>(
    "tree-touched", (e) => fn(e.payload.root, e.payload.files),
  );
}

export interface FolderSearchHit {
  path: string;
  name: string;
  matches: { line: number; text: string }[];
}

export interface FolderSearchOptions {
  regex: boolean;
  caseSensitive: boolean;
  wholeWord: boolean;
}

/** Search every markdown file under `root`; empty in browser mode (no FS).
 *  Rejects with "Invalid pattern: …" for a regex the backend can't compile. */
export async function searchInFolder(
  root: string,
  query: string,
  opts: FolderSearchOptions,
): Promise<FolderSearchHit[]> {
  if (web) return web.searchInFolder(root, query, opts);
  if (!isTauri) return [];
  const { invoke } = await tauriCore();
  return await invoke<FolderSearchHit[]>("search_in_folder", {
    root,
    query,
    regex: opts.regex,
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
  });
}

export async function clipboardWriteText(text: string): Promise<void> {
  if (!isTauri) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
  await writeText(text);
}

export async function clipboardReadText(): Promise<string> {
  if (!isTauri) return await navigator.clipboard.readText().catch(() => "");
  const { readText } = await import("@tauri-apps/plugin-clipboard-manager");
  return await readText().catch(() => "");
}

/** Native yes/no confirm (dialog plugin); window.confirm in the browser. */
export async function confirmDialog(message: string, title = "Sarala"): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return await ask(message, { title });
}

/**
 * "Save changes?" with Save / Don't Save / Cancel. The browser has no
 * three-button dialog, so there OK saves and Cancel keeps the document open
 * (never a silent discard).
 */
export async function askSaveDialog(message: string, title = "Sarala"): Promise<"save" | "discard" | "cancel"> {
  if (!isTauri) return window.confirm(message) ? "save" : "cancel";
  const { message: msg } = await import("@tauri-apps/plugin-dialog");
  const result = await msg(message, {
    title,
    kind: "warning",
    buttons: { yes: "Save", no: "Don't Save", cancel: "Cancel" },
  });
  // Custom buttons come back as their label; accept the stock names too.
  if (result === "Save" || result === "Yes") return "save";
  if (result === "Don't Save" || result === "No") return "discard";
  return "cancel";
}

/** Native message box; window.alert in the browser. */
export async function alertDialog(message: string, title = "Sarala"): Promise<void> {
  if (!isTauri) {
    window.alert(message);
    return;
  }
  const { message: msg } = await import("@tauri-apps/plugin-dialog");
  await msg(message, { title });
}

export async function pickImportFile(): Promise<string | null> {
  if (web) return web.pickImportFile();
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const sel = await open({
    multiple: false,
    filters: [{ name: "Importable", extensions: ["docx", "epub", "rst", "org", "odt", "html", "tex"] }],
  });
  return typeof sel === "string" ? sel : null;
}

export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "avif"];

export async function pickImageFile(): Promise<string | null> {
  if (web) return web.pickImageFile();
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const sel = await open({
    multiple: false,
    filters: [{ name: "Images", extensions: IMAGE_EXTS }],
  });
  return typeof sel === "string" ? sel : null;
}

/** Copy an image next to the document; returns the relative markdown path. */
export async function copyAsset(src: string, docDir: string, subfolder: string): Promise<string> {
  if (web) return web.copyAsset(src, docDir, subfolder);
  const { invoke } = await tauriCore();
  return await invoke<string>("copy_asset", { src, docDir, subfolder });
}

export async function renameFile(from: string, to: string): Promise<void> {
  if (web) return web.renameFile(from, to);
  const { invoke } = await tauriCore();
  await invoke("rename_file", { from, to });
}

/** Reveal a file in the OS file manager. */
export async function revealInDir(path: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("reveal_in_dir", { path });
}

/** Copy a file into a destination folder; returns the new absolute path. */
export async function copyFileTo(src: string, destDir: string): Promise<string> {
  if (web) return web.copyFileTo(src, destDir);
  const { invoke } = await tauriCore();
  return await invoke<string>("copy_file_to", { src, destDir });
}

export async function deleteFile(path: string): Promise<void> {
  if (web) return web.deleteFile(path);
  const { invoke } = await tauriCore();
  await invoke("delete_file", { path });
}

export async function openNewWindow(): Promise<void> {
  if (!isTauri) {
    window.open(web ? `${window.location.pathname}?new=1` : window.location.href, "_blank");
    return;
  }
  const { invoke } = await tauriCore();
  await invoke("new_window");
}

export async function hasPandoc(): Promise<boolean> {
  if (web) return web.hasPandoc();
  if (!isTauri) return false;
  const { invoke } = await tauriCore();
  return await invoke<boolean>("has_pandoc");
}

/** Download-on-demand: fetch pandoc into the app-data dir. Throws on failure. */
export async function downloadPandoc(): Promise<void> {
  const { invoke } = await tauriCore();
  await invoke("download_pandoc");
}

export async function pandocImport(path: string): Promise<string> {
  if (web) return web.pandocImport(path);
  const { invoke } = await tauriCore();
  return await invoke<string>("pandoc_import", { path });
}

export async function pandocExport(
  markdown: string,
  output: string,
  format: string,
  flags: string[] = [],
  baseDir: string | null = null,
): Promise<void> {
  if (web) return web.pandocExport(markdown, output, format, flags, baseDir);
  const { invoke } = await tauriCore();
  await invoke("pandoc_export", { markdown, output, format, flags });
}

/** Render standalone HTML to a PDF via headless Chromium. Throws if unavailable. */
export async function exportPdf(html: string, output: string): Promise<void> {
  if (web) return web.exportPdf(html, output);
  const { invoke } = await tauriCore();
  await invoke("export_pdf", { html, output });
}

/** Run a user-configured shell command (export preset after-action). */
export async function runCommand(command: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("run_command", { command });
}

export async function setWindowAlwaysOnTop(onTop: boolean): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setAlwaysOnTop(onTop);
}

export async function minimizeWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  if (!isTauri) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().toggleMaximize();
}

export async function toggleFullscreen(): Promise<void> {
  if (!isTauri) {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen().catch(() => {});
    return;
  }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const win = getCurrentWindow();
  await win.setFullscreen(!(await win.isFullscreen()));
}

/** Sync a native check/radio menu item with frontend state. Only macOS has a
 *  native menu now (elsewhere the in-app MenuBar reads state reactively). */
export async function setMenuChecked(id: string, checked: boolean): Promise<void> {
  if (!isTauri || !isMac) return;
  const { invoke } = await tauriCore();
  await invoke("set_menu_checked", { id, checked }).catch(() => {});
}

/** Enable/disable a native menu item. Only macOS has a native menu. */
export async function setMenuEnabled(id: string, enabled: boolean): Promise<void> {
  if (!isTauri || !isMac) return;
  const { invoke } = await tauriCore();
  await invoke("set_menu_enabled", { id, enabled }).catch(() => {});
}

/** False when something else owns this install (a snap, an AUR package, a
 *  distro build), so the in-app updater can't replace it. See can_self_update. */
export async function canSelfUpdate(): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await tauriCore();
  return invoke<boolean>("can_self_update").catch(() => true);
}

/** Restart the app (Rust `app.restart()`); used after an update installs. */
export async function relaunchApp(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("relaunch");
}

export async function openExternal(url: string): Promise<void> {
  if (web) return web.openExternal(url);
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
