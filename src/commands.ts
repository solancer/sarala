import {
  doc, fullText, fileName, loadDocument, markSaved, setFilePath, setHeading,
  sourceMode, setSourceMode, sidebarOpen, setSidebarOpen,
  theme, setTheme, THEMES, setFileTree, setFolderName,
  folderPath, setFolderPath, setQuickOpenVisible,
  moveBlock, removeBlock, updateBlock, insertBlockAfter, appendBlock,
  targetBlockIndex, requestCaret,
  spellcheckOn, setSpellcheckOn, smartPunctuation, setSmartPunctuation,
  preserveBreaks, setPreserveBreaks, lineEnding, setLineEnding,
  copyImageToAssets, setCopyImageToAssets, tableFullWidth, setTableFullWidth,
  setSidebarTab, focusMode, setFocusMode, typewriterMode, setTypewriterMode,
  alwaysOnTop, setAlwaysOnTop, zoom, setZoom, clampZoom,
  bumpRenderEpoch,
} from "./store";
import {
  isTauri, pickFolder, pickMarkdownFile, pickSavePath, pickImportFile,
  readTextFile, writeTextFile, listDirectory, openExternal,
  confirmDialog, alertDialog, renameFile, deleteFile, openNewWindow,
  hasPandoc, pandocImport, pandocExport,
  clipboardWriteText, clipboardReadText,
  pickImageFile, copyAsset,
  setWindowAlwaysOnTop, toggleFullscreen,
} from "./platform";
import { renderMarkdown, setPreserveBreaksOption } from "./markdown";
import {
  recentFiles, addRecentFile, clearRecentFiles, lastExport, setLastExport,
  setSetting,
} from "./settings";
import { openFind, findNext } from "./components/FindBar";
import { openTableDialog } from "./components/TableDialog";
import { skeletonTable, editTable, resizeTable, type TableEdit, type Align } from "./tabletools";

const HELP_URL = "https://github.com/inkdown/inkdown#readme";

/**
 * Handle to the currently active (contenteditable) block. Blocks register
 * themselves while active so menu/keyboard commands can edit at the caret.
 */
export interface BlockApi {
  wrap(before: string, after?: string): void;
  insertAtCaret(text: string, caretWithin?: number): void;
  selectRange(start: number, end: number): void;
  caretOffset(): number;
  selectionOffsets(): { start: number; end: number };
}

let blockApi: BlockApi | null = null;
export function registerBlockApi(api: BlockApi) {
  blockApi = api;
}
export function unregisterBlockApi(api: BlockApi) {
  if (blockApi === api) blockApi = null;
}
export function getActiveBlockApi(): BlockApi | null {
  return blockApi;
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

/** Document text with the configured line endings applied (Edit ▸ Line Endings). */
const textForDisk = () =>
  lineEnding() === "crlf" ? fullText().replace(/\n/g, "\r\n") : fullText();

export async function save() {
  let path = doc.filePath;
  if (!path) path = await pickSavePath(fileName());
  if (!path && isTauri) return;
  await writeTextFile(path ?? fileName(), textForDisk());
  if (path) {
    markSaved(path);
    await addRecentFile(path);
  }
}

async function saveAs() {
  const path = await pickSavePath(fileName());
  if (!path && isTauri) return;
  await writeTextFile(path ?? fileName(), textForDisk());
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

// ---------- Paragraph ----------

/** Replace the target block's text, parking the caret at a sane offset. */
function transformBlock(fn: (text: string) => string) {
  const i = targetBlockIndex();
  if (i < 0) return;
  const text = doc.blocks[i].text;
  const next = fn(text);
  if (next === text) return;
  requestCaret(Math.min(blockApi?.caretOffset() ?? next.length, next.length));
  updateBlock(i, next);
}

/** Apply fn to the line under the caret of the target block. */
function mutateCaretLine(fn: (line: string) => string) {
  transformBlock((text) => {
    const offset = blockApi?.caretOffset() ?? 0;
    const start = text.lastIndexOf("\n", offset - 1) + 1;
    const endIdx = text.indexOf("\n", offset);
    const end = endIdx === -1 ? text.length : endIdx;
    return text.slice(0, start) + fn(text.slice(start, end)) + text.slice(end);
  });
}

/** Insert a fresh block after the target (or at the end) and focus it. */
function insertBlock(text: string, caretWithin = text.length) {
  const at = targetBlockIndex();
  requestCaret(caretWithin);
  insertBlockAfter(at >= 0 ? at : doc.blocks.length - 1, text);
}

function shiftHeading(delta: number) {
  const i = targetBlockIndex();
  if (i < 0) return;
  const m = doc.blocks[i].text.match(/^(#{1,6})\s/);
  const level = m ? m[1].length : 0;
  setHeading(i, Math.max(0, Math.min(6, level + delta)));
}

const LIST_MARKER = /^(\s*)(?:[-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+)/;
const stripListMarker = (l: string) => l.replace(LIST_MARKER, "$1");

/** Toggle a per-line list marker on the whole block. */
function toggleList(kind: "ul" | "ol" | "task") {
  const has = {
    ul: (l: string) => /^\s*[-*+]\s+(?!\[[ xX]\]\s)/.test(l),
    ol: (l: string) => /^\s*\d+\.\s+/.test(l),
    task: (l: string) => /^\s*[-*+]\s+\[[ xX]\]\s/.test(l),
  }[kind];
  transformBlock((text) => {
    const lines = text.split("\n");
    const content = lines.filter((l) => l.trim() !== "");
    if (content.length && content.every(has)) return lines.map(stripListMarker).join("\n");
    let n = 0;
    return lines
      .map((l) => {
        if (l.trim() === "") return l;
        const core = stripListMarker(l).trimStart();
        if (kind === "ol") return `${++n}. ${core}`;
        if (kind === "task") return `- [ ] ${core}`;
        return `- ${core}`;
      })
      .join("\n");
  });
}

function toggleQuote(text: string): string {
  const lines = text.split("\n");
  const content = lines.filter((l) => l.trim() !== "");
  if (content.length && content.every((l) => /^\s*>/.test(l))) {
    return lines.map((l) => l.replace(/^(\s*)>\s?/, "$1")).join("\n");
  }
  return lines.map((l) => "> " + l).join("\n");
}

function applyTableEdit(edit: TableEdit) {
  const i = targetBlockIndex();
  if (i < 0) return;
  const text = doc.blocks[i].text;
  const next = editTable(text, blockApi?.caretOffset() ?? 0, edit);
  if (next == null || next === text) return;
  requestCaret(Math.min(blockApi?.caretOffset() ?? 0, next.length));
  updateBlock(i, next);
}

const tableAlign = (align: Align) => () => applyTableEdit({ kind: "align", align });

/** Called by the TableDialog overlay with the chosen dimensions. */
export function insertTable(rows: number, cols: number) {
  const md = skeletonTable(rows, cols);
  insertBlock(md, md.indexOf("|") + 2);
}

/** Table toolbar: tables stretch to the page column or size to content. */
export async function toggleTableFullWidth() {
  const v = !tableFullWidth();
  setTableFullWidth(v);
  await setSetting("tableFullWidth", v);
}

/** Called by the table toolbar's grid picker. Rows include the header. */
export function resizeActiveTable(rows: number, cols: number) {
  const i = targetBlockIndex();
  if (i < 0) return;
  const text = doc.blocks[i].text;
  const next = resizeTable(text, rows, cols);
  if (next == null || next === text) return;
  requestCaret(Math.min(blockApi?.caretOffset() ?? 0, next.length));
  updateBlock(i, next);
}

function insertFootnote() {
  if (!blockApi || targetBlockIndex() < 0) return;
  const defs = doc.blocks.flatMap((b) =>
    [...b.text.matchAll(/^\[\^(\d+)\]:/gm)].map((m) => Number(m[1]))
  );
  const n = (defs.length ? Math.max(...defs) : 0) + 1;
  blockApi.insertAtCaret(`[^${n}]`);
  appendBlock(`[^${n}]: `);
}

function insertFrontMatter() {
  if (doc.blocks[0]?.text.startsWith("---\n")) return;
  requestCaret(4);
  insertBlockAfter(-1, "---\n\n---");
}

// ---------- Edit ----------

async function copyAsMarkdown() {
  const text = doc.activeIndex >= 0 ? doc.blocks[doc.activeIndex].text : fullText();
  await clipboardWriteText(text);
}

async function pastePlain() {
  const text = await clipboardReadText();
  if (text && blockApi) blockApi.insertAtCaret(text);
}

function selectLine() {
  if (!blockApi || doc.activeIndex < 0) return;
  const text = doc.blocks[doc.activeIndex].text;
  const offset = blockApi.caretOffset();
  const start = text.lastIndexOf("\n", offset - 1) + 1;
  const endIdx = text.indexOf("\n", offset);
  blockApi.selectRange(start, endIdx === -1 ? text.length : endIdx);
}

function selectWord() {
  // Selection.modify is non-standard but supported by WebKit/Blink/Gecko.
  const sel = window.getSelection() as
    | (Selection & { modify?: (alter: string, dir: string, granularity: string) => void })
    | null;
  if (!sel?.modify) return;
  sel.modify("move", "backward", "word");
  sel.modify("extend", "forward", "word");
}

async function toggleSpellcheck() {
  const v = !spellcheckOn();
  setSpellcheckOn(v);
  await setSetting("spellcheck", v);
}

async function toggleSmartPunctuation() {
  const v = !smartPunctuation();
  setSmartPunctuation(v);
  await setSetting("smartPunctuation", v);
}

async function togglePreserveBreaks() {
  const v = !preserveBreaks();
  setPreserveBreaks(v);
  setPreserveBreaksOption(v);
  bumpRenderEpoch();
  await setSetting("preserveBreaks", v);
}

async function chooseLineEnding(v: "lf" | "crlf") {
  setLineEnding(v);
  await setSetting("lineEnding", v);
}

// ---------- Format ----------

/** The markdown/bare link whose source span contains the caret, if any. */
function linkAtCaret(): string | null {
  const i = targetBlockIndex();
  if (i < 0) return null;
  const text = doc.blocks[i].text;
  const offset = blockApi?.caretOffset() ?? 0;
  for (const m of text.matchAll(/\[[^\]\n]*\]\(([^)\s]+)[^)]*\)/g)) {
    if (offset >= m.index && offset <= m.index + m[0].length) return m[1];
  }
  for (const m of text.matchAll(/https?:\/\/[^\s<>)"]+/g)) {
    if (offset >= m.index && offset <= m.index + m[0].length) return m[0];
  }
  return null;
}

function stripInlineMarkers(s: string): string {
  let out = s;
  // Two passes unwrap one level of nesting (e.g. bold inside a link label).
  for (let pass = 0; pass < 2; pass++) {
    out = out
      .replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, "$2")
      .replace(/(\*|_)(?=\S)([^*_\n]*?\S)\1/g, "$2")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "$1")
      .replace(/`([^`\n]+)`/g, "$1")
      .replace(/<\/?u>/g, "")
      .replace(/<!--\s?|\s?-->/g, "");
  }
  return out;
}

function clearFormat() {
  const i = targetBlockIndex();
  if (i < 0) return;
  const sel = blockApi?.selectionOffsets();
  if (sel && sel.end > sel.start) {
    const text = doc.blocks[i].text;
    blockApi!.insertAtCaret(stripInlineMarkers(text.slice(sel.start, sel.end)));
  } else {
    transformBlock(stripInlineMarkers);
  }
}

const docDir = (): string | null => {
  const path = doc.filePath;
  if (!path) return null;
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : null;
};

/** Insert an image reference, honoring the copy-to-assets setting. */
export async function insertImageFromPath(absPath: string) {
  let ref = absPath;
  const dir = docDir();
  if (dir && copyImageToAssets()) {
    try {
      ref = await copyAsset(absPath, dir, "assets");
    } catch (e) {
      await alertDialog(String(e));
    }
  } else if (dir) {
    const norm = (p: string) => p.replace(/\\/g, "/");
    if (norm(absPath).startsWith(norm(dir) + "/")) ref = norm(absPath).slice(norm(dir).length + 1);
  }
  const md = `![](${ref})`;
  if (blockApi) blockApi.insertAtCaret(md, md.length - 1);
  else insertBlock(md, md.length - 1);
}

async function insertImage() {
  const path = await pickImageFile();
  if (path) await insertImageFromPath(path);
}

async function toggleCopyImageToAssets() {
  const v = !copyImageToAssets();
  setCopyImageToAssets(v);
  await setSetting("copyImageToAssets", v);
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

  // Edit
  "edit.copy_markdown": copyAsMarkdown,
  "edit.copy_html": () => clipboardWriteText(renderMarkdown(fullText())),
  "edit.paste_plain": pastePlain,
  "edit.move_row_up": () => { if (doc.activeIndex >= 0) moveBlock(doc.activeIndex, -1); },
  "edit.move_row_down": () => { if (doc.activeIndex >= 0) moveBlock(doc.activeIndex, 1); },
  "edit.delete_block": () => { if (doc.activeIndex >= 0) removeBlock(doc.activeIndex); },
  "edit.select_block": () => {
    if (doc.activeIndex >= 0) blockApi?.selectRange(0, doc.blocks[doc.activeIndex].text.length);
  },
  "edit.select_line": selectLine,
  "edit.select_word": selectWord,
  "edit.find": () => { openFind(false); },
  "edit.find_next": () => { findNext(1); },
  "edit.replace": () => { openFind(true); },
  "edit.smart_punctuation": toggleSmartPunctuation,
  "edit.spellcheck": toggleSpellcheck,
  "edit.line_ending.lf": () => chooseLineEnding("lf"),
  "edit.line_ending.crlf": () => chooseLineEnding("crlf"),
  "edit.preserve_breaks": togglePreserveBreaks,

  // Paragraph — headings act on the active block
  "paragraph.heading.0": heading(0),
  "paragraph.heading.1": heading(1),
  "paragraph.heading.2": heading(2),
  "paragraph.heading.3": heading(3),
  "paragraph.heading.4": heading(4),
  "paragraph.heading.5": heading(5),
  "paragraph.heading.6": heading(6),
  "paragraph.heading_up": () => shiftHeading(1),
  "paragraph.heading_down": () => shiftHeading(-1),
  "paragraph.table.insert": () => openTableDialog(),
  "paragraph.table.row_above": () => applyTableEdit({ kind: "row_above" }),
  "paragraph.table.row_below": () => applyTableEdit({ kind: "row_below" }),
  "paragraph.table.delete_row": () => applyTableEdit({ kind: "delete_row" }),
  "paragraph.table.add_col": () => applyTableEdit({ kind: "add_col" }),
  "paragraph.table.delete_col": () => applyTableEdit({ kind: "delete_col" }),
  "paragraph.table.align_left": tableAlign("left"),
  "paragraph.table.align_center": tableAlign("center"),
  "paragraph.table.align_right": tableAlign("right"),
  "paragraph.math_block": () => insertBlock("$$\n\n$$", 3),
  "paragraph.code_fences": () => insertBlock("```\n\n```", 4),
  "paragraph.quote": () => transformBlock(toggleQuote),
  "paragraph.ordered_list": () => toggleList("ol"),
  "paragraph.unordered_list": () => toggleList("ul"),
  "paragraph.task_list": () => toggleList("task"),
  "paragraph.task_toggle": () =>
    mutateCaretLine((l) => l.replace(/\[( |x|X)\]/, (_, s) => (s === " " ? "[x]" : "[ ]"))),
  "paragraph.indent": () => mutateCaretLine((l) => "  " + l),
  "paragraph.outdent": () => mutateCaretLine((l) => l.replace(/^ {1,2}/, "")),
  "paragraph.insert_before": () => {
    const i = targetBlockIndex();
    if (i >= 0) insertBlockAfter(i - 1);
  },
  "paragraph.insert_after": () => {
    const i = targetBlockIndex();
    if (i >= 0) insertBlockAfter(i);
  },
  "paragraph.hr": () => insertBlock("---"),
  "paragraph.toc": () => insertBlock("[TOC]"),
  "paragraph.front_matter": insertFrontMatter,
  "paragraph.footnote": insertFootnote,
  "paragraph.alert.note": () => insertBlock("> [!NOTE]\n> "),
  "paragraph.alert.tip": () => insertBlock("> [!TIP]\n> "),
  "paragraph.alert.warning": () => insertBlock("> [!WARNING]\n> "),

  // Format — inline wraps at the caret of the active block
  "format.strong": wrap("**"),
  "format.emphasis": wrap("*"),
  "format.code": wrap("`"),
  "format.strike": wrap("~~"),
  "format.underline": wrap("<u>", "</u>"),
  "format.comment": wrap("<!-- ", " -->"),
  "format.inline_math": wrap("$"),
  "format.hyperlink": wrap("[", "](url)"),
  "format.link.open": async () => {
    const url = linkAtCaret();
    if (url) await openExternal(url);
  },
  "format.link.copy": async () => {
    const url = linkAtCaret();
    if (url) await clipboardWriteText(url);
  },
  "format.image.insert": insertImage,
  "format.image.copy_to_folder": toggleCopyImageToAssets,
  "format.image.root_path": () => alertDialog("Image root path is not implemented yet."),
  "format.image.upload": () => alertDialog("Image upload is not implemented yet."),
  "format.clear": clearFormat,

  // View
  "view.source_mode": () => { setSourceMode(!sourceMode()); },
  "view.sidebar": () => { setSidebarOpen(!sidebarOpen()); },
  "view.file_tree": () => { setSidebarOpen(true); setSidebarTab("files"); },
  "view.outline": () => { setSidebarOpen(true); setSidebarTab("outline"); },
  "view.search": () => { openFind(false); },
  "view.focus_mode": () => { setFocusMode(!focusMode()); },
  "view.typewriter_mode": () => { setTypewriterMode(!typewriterMode()); },
  "view.zoom_in": () => changeZoom(zoom() + 10),
  "view.zoom_out": () => changeZoom(zoom() - 10),
  "view.zoom_actual": () => changeZoom(100),
  "view.always_on_top": async () => {
    const v = !alwaysOnTop();
    setAlwaysOnTop(v);
    await setWindowAlwaysOnTop(v);
  },
  "view.fullscreen": () => toggleFullscreen(),

  // Help
  "help.readme": () => openExternal(HELP_URL),
};

async function changeZoom(value: number) {
  const z = clampZoom(value);
  setZoom(z);
  await setSetting("zoom", z);
}

for (const id of THEMES) {
  registry[`themes.set.${id}`] = async () => {
    setTheme(id);
    await setSetting("theme", id);
  };
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
