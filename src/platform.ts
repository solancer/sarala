export interface FileNode {
  name: string;
  path: string;
  is_dir: boolean;
  children?: FileNode[];
}

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

async function tauriCore() {
  return await import("@tauri-apps/api/core");
}

export async function pickMarkdownFile(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const sel = await open({
    multiple: false,
    filters: [{ name: "Markdown", extensions: ["md", "markdown", "txt"] }],
  });
  return typeof sel === "string" ? sel : null;
}

export async function pickFolder(): Promise<string | null> {
  if (!isTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const sel = await open({ directory: true, multiple: false });
  return typeof sel === "string" ? sel : null;
}

export async function pickSavePath(defaultName: string): Promise<string | null> {
  if (!isTauri) return null;
  const { save } = await import("@tauri-apps/plugin-dialog");
  return await save({ defaultPath: defaultName });
}

export async function readTextFile(path: string): Promise<string> {
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
  const { invoke } = await tauriCore();
  return normEncoded(await invoke<RawEncodedDoc>("read_file_encoded", { path }));
}

/** Re-decode a file with an explicit encoding label (the encoding picker). */
export async function reopenWithEncoding(path: string, label: string): Promise<EncodedDoc> {
  const { invoke } = await tauriCore();
  return normEncoded(await invoke<RawEncodedDoc>("reopen_with_encoding", { path, label }));
}

export async function writeTextFile(
  path: string,
  contents: string,
  encoding = "UTF-8",
  bom = false,
): Promise<void> {
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
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("watch_file", { path }).catch(() => {});
}

export async function unwatchFile(path: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("unwatch_file", { path }).catch(() => {});
}

/** Listen for the Rust watcher's external-change/-removed events. */
export async function onExternalChange(
  fn: (path: string, deleted: boolean) => void,
): Promise<() => void> {
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

export async function listDirectory(path: string): Promise<FileNode[]> {
  const { invoke } = await tauriCore();
  return await invoke<FileNode[]>("list_dir", { path });
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

/** Search every markdown file under `root`; empty in browser mode (no FS). */
export async function searchInFolder(
  root: string,
  query: string,
  opts: FolderSearchOptions,
): Promise<FolderSearchHit[]> {
  if (!isTauri) return [];
  const { invoke } = await tauriCore();
  return await invoke<FolderSearchHit[]>("search_in_folder", {
    root,
    query,
    regex: opts.regex,
    caseSensitive: opts.caseSensitive,
    wholeWord: opts.wholeWord,
  }).catch(() => []);
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
  const { invoke } = await tauriCore();
  return await invoke<string>("copy_asset", { src, docDir, subfolder });
}

export async function renameFile(from: string, to: string): Promise<void> {
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
  const { invoke } = await tauriCore();
  return await invoke<string>("copy_file_to", { src, destDir });
}

export async function deleteFile(path: string): Promise<void> {
  const { invoke } = await tauriCore();
  await invoke("delete_file", { path });
}

export async function openNewWindow(): Promise<void> {
  if (!isTauri) {
    window.open(window.location.href, "_blank");
    return;
  }
  const { invoke } = await tauriCore();
  await invoke("new_window");
}

export async function hasPandoc(): Promise<boolean> {
  if (!isTauri) return false;
  const { invoke } = await tauriCore();
  return await invoke<boolean>("has_pandoc");
}

export async function pandocImport(path: string): Promise<string> {
  const { invoke } = await tauriCore();
  return await invoke<string>("pandoc_import", { path });
}

export async function pandocExport(
  markdown: string,
  output: string,
  format: string,
  flags: string[] = [],
): Promise<void> {
  const { invoke } = await tauriCore();
  await invoke("pandoc_export", { markdown, output, format, flags });
}

/** Render standalone HTML to a PDF via headless Chromium. Throws if unavailable. */
export async function exportPdf(html: string, output: string): Promise<void> {
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

/** Sync a native check/radio menu item with frontend state. No-op in browser. */
export async function setMenuChecked(id: string, checked: boolean): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("set_menu_checked", { id, checked }).catch(() => {});
}

/** Enable/disable a native menu item. No-op in browser. */
export async function setMenuEnabled(id: string, enabled: boolean): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("set_menu_enabled", { id, enabled }).catch(() => {});
}

/** Restart the app (Rust `app.restart()`); used after an update installs. */
export async function relaunchApp(): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("relaunch");
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
