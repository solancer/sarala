import {
  doc, fullText, fileName, loadDocument, markSaved, setFilePath, setHeading,
  sourceMode, setSourceMode, sidebarOpen, setSidebarOpen,
  theme, setTheme, THEMES, setFileTree, setFolderName,
  folderPath, setFolderPath, setQuickOpenVisible,
} from "./store";
import {
  isTauri, pickFolder, pickMarkdownFile, pickSavePath, pickImportFile,
  readTextFile, writeTextFile, listDirectory, openExternal,
  confirmDialog, alertDialog, renameFile, deleteFile, openNewWindow,
  hasPandoc, pandocImport, pandocExport,
} from "./platform";
import { renderMarkdown } from "./markdown";
import {
  recentFiles, addRecentFile, clearRecentFiles, lastExport, setLastExport,
} from "./settings";

const HELP_URL = "https://github.com/inkdown/inkdown#readme";

/**
 * Handle to the currently active (contenteditable) block. Blocks register
 * themselves while active so menu/keyboard commands can edit at the caret.
 */
export interface BlockApi {
  wrap(before: string, after?: string): void;
  insertAtCaret(text: string, caretWithin?: number): void;
}

let blockApi: BlockApi | null = null;
export function registerBlockApi(api: BlockApi) {
  blockApi = api;
}
export function unregisterBlockApi(api: BlockApi) {
  if (blockApi === api) blockApi = null;
}

const withBlock = (fn: (api: BlockApi) => void) => () => {
  if (blockApi) fn(blockApi);
};
const wrap = (before: string, after?: string) => withBlock((b) => b.wrap(before, after));
const heading = (level: number) => () => {
  if (doc.activeIndex >= 0) setHeading(doc.activeIndex, level);
};

// ---------- Workspace ----------

export async function refreshTree() {
  const root = folderPath();
  if (root) setFileTree(await listDirectory(root));
}

export async function openFolder() {
  const path = await pickFolder();
  if (!path) return;
  setFolderPath(path);
  setFolderName(path.replace(/\\/g, "/").split("/").pop() ?? path);
  setFileTree(await listDirectory(path));
}

// ---------- File ----------

/** True when it is safe to discard the current document. */
async function confirmDiscard(): Promise<boolean> {
  if (!doc.dirty) return true;
  return confirmDialog(`Discard unsaved changes to ${fileName()}?`);
}

export async function openFile(path?: string) {
  const p = path ?? (await pickMarkdownFile());
  if (!p) return;
  loadDocument(await readTextFile(p), p);
  await addRecentFile(p);
}

async function newFile() {
  if (await confirmDiscard()) loadDocument("", null);
}

export async function save() {
  let path = doc.filePath;
  if (!path) path = await pickSavePath(fileName());
  if (!path && isTauri) return;
  await writeTextFile(path ?? fileName(), fullText());
  if (path) {
    markSaved(path);
    await addRecentFile(path);
  }
}

async function saveAs() {
  const path = await pickSavePath(fileName());
  if (!path && isTauri) return;
  await writeTextFile(path ?? fileName(), fullText());
  if (path) {
    markSaved(path);
    await addRecentFile(path);
    await refreshTree();
  }
}

async function renameCurrent() {
  const from = doc.filePath;
  if (!from) {
    await alertDialog("Save the document before renaming it.");
    return;
  }
  // The native save dialog doubles as the rename/move prompt: it returns the
  // new path and warns on overwrite. wry has no window.prompt().
  const to = await pickSavePath(fileName());
  if (!to || to === from) return;
  try {
    await renameFile(from, to);
    setFilePath(to);
    await addRecentFile(to);
    await refreshTree();
  } catch (e) {
    await alertDialog(String(e));
  }
}

async function deleteCurrent() {
  const path = doc.filePath;
  if (!path) return;
  if (!(await confirmDialog(`Delete ${fileName()}? This cannot be undone.`))) return;
  try {
    await deleteFile(path);
    loadDocument("", null);
    await refreshTree();
  } catch (e) {
    await alertDialog(String(e));
  }
}

async function revertToSaved() {
  const path = doc.filePath;
  if (!path) return;
  if (doc.dirty && !(await confirmDialog(`Revert ${fileName()} to the last saved version?`))) return;
  loadDocument(await readTextFile(path), path);
}

async function importViaPandoc() {
  if (!(await hasPandoc())) {
    await alertDialog("Importing requires Pandoc. Install it from pandoc.org and try again.");
    return;
  }
  if (!(await confirmDiscard())) return;
  const path = await pickImportFile();
  if (!path) return;
  try {
    loadDocument(await pandocImport(path), null);
  } catch (e) {
    await alertDialog(`Pandoc import failed:\n${String(e)}`);
  }
}

// ---------- Export ----------

const htmlBaseName = () => fileName().replace(/\.(md|markdown|txt)$/i, "");

async function exportHtmlTo(path: string | null, withStyles: boolean): Promise<string | null> {
  const css = withStyles
    ? await fetch(new URL("./styles/export.css", import.meta.url))
        .then((r) => r.text())
        .catch(() => "")
    : "";
  const body = renderMarkdown(fullText());
  const style = css ? `<style>${css}</style>` : "";
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${fileName()}</title>${style}</head><body data-theme="${theme()}"><article class="rendered">${body}</article></body></html>`;
  const out = path ?? (await pickSavePath(htmlBaseName() + ".html"));
  if (!out && isTauri) return null;
  await writeTextFile(out ?? htmlBaseName() + ".html", html);
  return out;
}

export async function exportHtml() {
  await doExport("file.export.html");
}

// Pandoc-backed export formats: menu id suffix → pandoc writer + extension.
const PANDOC_EXPORTS: Record<string, { format: string; ext: string }> = {
  "file.export.docx": { format: "docx", ext: "docx" },
  "file.export.odt": { format: "odt", ext: "odt" },
  "file.export.rtf": { format: "rtf", ext: "rtf" },
  "file.export.epub": { format: "epub", ext: "epub" },
  "file.export.latex": { format: "latex", ext: "tex" },
  "file.export.mediawiki": { format: "mediawiki", ext: "wiki" },
  "file.export.rst": { format: "rst", ext: "rst" },
  "file.export.textile": { format: "textile", ext: "textile" },
  "file.export.opml": { format: "opml", ext: "opml" },
};

async function doExport(id: string, previousPath: string | null = null) {
  if (id === "file.export.pdf") {
    window.print();
    return;
  }
  if (id === "file.export.html" || id === "file.export.html_plain") {
    const out = await exportHtmlTo(previousPath, id === "file.export.html");
    if (out) await setLastExport({ id, path: out });
    return;
  }
  const spec = PANDOC_EXPORTS[id];
  if (!spec) return;
  if (!(await hasPandoc())) {
    await alertDialog("This export format requires Pandoc. Install it from pandoc.org and try again.");
    return;
  }
  const out = previousPath ?? (await pickSavePath(`${htmlBaseName()}.${spec.ext}`));
  if (!out) return;
  try {
    await pandocExport(fullText(), out, spec.format);
    await setLastExport({ id, path: out });
  } catch (e) {
    await alertDialog(`Pandoc export failed:\n${String(e)}`);
  }
}

async function exportPrevious() {
  const memo = lastExport();
  if (!memo) {
    await alertDialog("No previous export to repeat.");
    return;
  }
  await doExport(memo.id, memo.path);
}

// ---------- Registry ----------

type Command = () => void | Promise<void>;

const registry: Record<string, Command> = {
  // File
  "file.new": newFile,
  "file.new_window": () => openNewWindow(),
  "file.open": () => openFile(),
  "file.open_quickly": () => { setQuickOpenVisible(true); },
  "file.open_folder": openFolder,
  "file.open_recent.clear": () => clearRecentFiles(),
  "file.close": newFile,
  "file.save": save,
  "file.save_as": saveAs,
  "file.rename": renameCurrent,
  "file.delete": deleteCurrent,
  "file.revert.last_saved": revertToSaved,
  "file.import": importViaPandoc,
  "file.export.previous": exportPrevious,
  "file.print": () => { window.print(); },

  // Paragraph — headings act on the active block
  "paragraph.heading.0": heading(0),
  "paragraph.heading.1": heading(1),
  "paragraph.heading.2": heading(2),
  "paragraph.heading.3": heading(3),
  "paragraph.heading.4": heading(4),
  "paragraph.heading.5": heading(5),
  "paragraph.heading.6": heading(6),

  // Format — inline wraps at the caret of the active block
  "format.strong": wrap("**"),
  "format.emphasis": wrap("*"),
  "format.code": wrap("`"),
  "format.strike": wrap("~~"),
  "format.underline": wrap("<u>", "</u>"),
  "format.comment": wrap("<!-- ", " -->"),
  "format.inline_math": wrap("$"),
  "format.hyperlink": wrap("[", "](url)"),

  // View
  "view.source_mode": () => { setSourceMode(!sourceMode()); },
  "view.sidebar": () => { setSidebarOpen(!sidebarOpen()); },

  // Help
  "help.readme": () => openExternal(HELP_URL),
};

for (const id of THEMES) {
  registry[`themes.set.${id}`] = () => { setTheme(id); };
}
for (const id of Object.keys(PANDOC_EXPORTS).concat("file.export.html", "file.export.html_plain", "file.export.pdf")) {
  registry[id] = () => doExport(id);
}

export function executeCommand(id: string) {
  const recent = id.match(/^file\.open_recent\.item\.(\d+)$/);
  if (recent) {
    const path = recentFiles()[Number(recent[1])];
    if (path) void openFile(path);
    return;
  }
  const command = registry[id];
  if (!command) {
    console.warn("TODO: unimplemented menu command", id);
    return;
  }
  void command();
}
