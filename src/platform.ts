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

export async function writeTextFile(path: string, contents: string): Promise<void> {
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
  await invoke("save_file", { path, contents });
}

export async function listDirectory(path: string): Promise<FileNode[]> {
  const { invoke } = await tauriCore();
  return await invoke<FileNode[]>("list_dir", { path });
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
export async function confirmDialog(message: string, title = "Inkdown"): Promise<boolean> {
  if (!isTauri) return window.confirm(message);
  const { ask } = await import("@tauri-apps/plugin-dialog");
  return await ask(message, { title });
}

/** Native message box; window.alert in the browser. */
export async function alertDialog(message: string, title = "Inkdown"): Promise<void> {
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

export async function renameFile(from: string, to: string): Promise<void> {
  const { invoke } = await tauriCore();
  await invoke("rename_file", { from, to });
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

export async function pandocExport(markdown: string, output: string, format: string): Promise<void> {
  const { invoke } = await tauriCore();
  await invoke("pandoc_export", { markdown, output, format });
}

/** Sync a native check/radio menu item with frontend state. No-op in browser. */
export async function setMenuChecked(id: string, checked: boolean): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await tauriCore();
  await invoke("set_menu_checked", { id, checked }).catch(() => {});
}

export async function openExternal(url: string): Promise<void> {
  if (!isTauri) {
    window.open(url, "_blank", "noopener");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
