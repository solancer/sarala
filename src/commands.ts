import {
  doc, fullText, fileName, loadDocument, markSaved, setHeading,
  sourceMode, setSourceMode, sidebarOpen, setSidebarOpen,
  theme, setTheme, THEMES, setFileTree, setFolderName,
} from "./store";
import {
  isTauri, pickFolder, pickMarkdownFile, pickSavePath,
  readTextFile, writeTextFile, listDirectory, openExternal,
} from "./platform";
import { renderMarkdown } from "./markdown";

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

export async function openFolder() {
  const path = await pickFolder();
  if (!path) return;
  setFolderName(path.replace(/\\/g, "/").split("/").pop() ?? path);
  setFileTree(await listDirectory(path));
}

export async function openFile(path?: string) {
  const p = path ?? (await pickMarkdownFile());
  if (!p) return;
  loadDocument(await readTextFile(p), p);
}

export async function save() {
  let path = doc.filePath;
  if (!path) path = await pickSavePath(fileName());
  if (!path && isTauri) return;
  await writeTextFile(path ?? fileName(), fullText());
  if (path) markSaved(path);
}

export async function exportHtml() {
  const css = await fetch(new URL("./styles/export.css", import.meta.url))
    .then((r) => r.text())
    .catch(() => "");
  const body = renderMarkdown(fullText());
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${fileName()}</title><style>${css}</style></head><body data-theme="${theme()}"><article class="rendered">${body}</article></body></html>`;
  const out = await pickSavePath(fileName().replace(/\.(md|markdown|txt)$/i, "") + ".html");
  await writeTextFile(out ?? fileName() + ".html", html);
}

type Command = () => void | Promise<void>;

const registry: Record<string, Command> = {
  // File
  "file.open": () => openFile(),
  "file.open_folder": openFolder,
  "file.save": save,
  "file.export.html": exportHtml,

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

// Themes
for (const id of THEMES) {
  registry[`themes.set.${id}`] = () => { setTheme(id); };
}

export function executeCommand(id: string) {
  const command = registry[id];
  if (!command) {
    console.warn("TODO: unimplemented menu command", id);
    return;
  }
  void command();
}
