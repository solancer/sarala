import {
  doc, fullText, fileName, retargetTabPath, cycleTab, setHeading,
  activeTabId, openDocument, findTabByPath, switchTab, removeTab, getTabDocument, markTabSaved, replaceTabDocument,
  sourceMode, setSourceMode, sidebarOpen, setSidebarOpen,
  theme, setTheme, THEMES, setFileTree, setFolderName,
  folderPath, setFolderPath, setQuickOpenVisible, setCommandPaletteVisible,
  moveBlock, removeBlock, updateBlock, insertBlockAfter, appendBlock,
  targetBlockIndex, requestCaret, requestSelection, undo, redo, setCaretProvider,
  spellcheckOn, setSpellcheckOn, smartPunctuation, setSmartPunctuation,
  preserveBreaks, setPreserveBreaks, lineEnding, setLineEnding,
  finalNewline, setFinalNewline, setAutosaveInterval,
  setEncodingLossy, setExternalChange, setDocDirty,
  copyImageToAssets, setCopyImageToAssets, copyImagesToFolder, tableFullWidth, setTableFullWidth,
  mathAltDelimiters, setMathAltDelimitersSig, mathFence, setMathFenceSig,
  emojiEnabled, setEmojiEnabledSig, highlightEnabled, setHighlightEnabledSig,
  subSupEnabled, setSubSupEnabledSig, autolinkEnabled, setAutolinkEnabledSig,
  setSidebarTab, focusMode, setFocusMode, typewriterMode, setTypewriterMode,
  statusBarVisible, setStatusBarVisible,
  alwaysOnTop, setAlwaysOnTop, zoom, setZoom, clampZoom,
  bumpRenderEpoch, proseFont, monoFont, markMissing,
} from "./store";
import { selectAllDocument } from "./blockselect";
import { toggleMark, type MarkKind } from "./inlineformat";
import { linkDestination } from "./links";
import { applyBlockKind, type BlockKind } from "./blocktype";
import { fontEmbedCss } from "./fonts";
import {
  isTauri, pickFolder, pickMarkdownFile, pickSavePath, pickImportFile,
  readFileEncoded, reopenWithEncoding, writeTextFile, type EncodedDoc,
  watchFile, clearShadow, listDirectory, openExternal,
  confirmDialog, alertDialog, renameFile, deleteFile, openNewWindow,
  pandocImport, pandocExport, exportPdf, runCommand, revealInDir,
  clipboardWriteText, clipboardReadText, pathExists,
  pickImageFile, copyAsset,
  setWindowAlwaysOnTop, toggleFullscreen, minimizeWindow, toggleMaximizeWindow,
} from "./platform";
import {
  renderMarkdown, joinBlocks, setPreserveBreaksOption, prepareRender,
  setMathAltDelimiters as setMathAltDelimitersOpt,
  setMathFence as setMathFenceOpt,
  setEmojiEnabled as setEmojiEnabledOpt,
  setHighlightEnabled as setHighlightEnabledOpt,
  setSubSupEnabled as setSubSupEnabledOpt,
  setAutolinkEnabled as setAutolinkEnabledOpt,
} from "./markdown";
import { renderMermaidIn } from "./mermaid";
import { renderD2In } from "./d2";
import { setLiveHighlight, setLiveSubSup } from "./livesource";
import { shadowFor, restoreSession, keyForPath, discardShadowFor } from "./autosave";
import { stripControlChars } from "./richpaste";
import {
  recentFiles, addRecentFile, clearRecentFiles, removeRecentFile, pinnedFiles,
  lastExport, setLastExport, exportPresets, pdfOptions, setSetting,
} from "./settings";
import {
  buildExportHtml, pageCss, readExportOverrides, pandocFlagsFor, resolveOutputPath,
  EXPORT_PRINT_CSS, PDF_PRINT_CSS, type ExportPreset, type ExportFormat,
} from "./export";
import { docDir, currentFrontMatter, docBaseName, stripFrontMatter } from "./images";
import { setImageRootPath } from "./imageactions";
// The app stylesheet as a string (bundled at build time), so exports embed it
// reliably — a runtime fetch of a side-effect-imported CSS file is fragile in
// packaged builds.
import appCssText from "./styles/app.css?inline";
import { askHtmlOutline } from "./components/ExportHtmlDialog";
import { openFind, findNext } from "./components/FindBar";
import { openTableDialog } from "./components/TableDialog";
import { openAbout } from "./components/AboutModal";
import { ensurePandoc } from "./components/PandocDownloadModal";
import { openSettings } from "./components/SettingsModal";
import { openThemePicker } from "./components/ThemePicker";
import { openThemeEditor } from "./components/ThemeEditor";
import { checkForUpdates } from "./updater";
import {
  skeletonTable, editTable, resizeTable, prettifyTable, parseTable, cellRanges, columnAtOffset, lineAtOffset,
  appendTableRow, appendTableColumn, type TableAppend, type TableEdit, type Align,
} from "./tabletools";

const HELP_URL = "https://github.com/solancer/sarala#readme";

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

// Undo snapshots include the caret of the active block.
setCaretProvider(() => (blockApi ? blockApi.caretOffset() : null));

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

/** Load or reload the requested buffer, never an unrelated active tab. */
async function applyOpened(p: string, ed: EncodedDoc, tabId?: number) {
  if (tabId === undefined) {
    const id = openDocument(ed.content, p, ed);
    if (id === activeTabId()) setEncodingLossy(ed.lossy);
  } else replaceTabDocument(tabId, ed.content, p, ed, ed.lossy);
  await watchFile(p);
}

const closingTabs = new Set<number>();
export async function closeTab(id = activeTabId()): Promise<void> {
  if (closingTabs.has(id)) return;
  const document = getTabDocument(id);
  if (!document) return;
  closingTabs.add(id);
  try {
    const name = document.filePath ? fileName0(document.filePath) : "Untitled.md";
    if (document.dirty && !(await confirmDialog(`Close ${name} without saving? Unsaved changes will be lost.`))) return;
    removeTab(id);
    await discardShadowFor(document.filePath);
  } finally { closingTabs.delete(id); }
}

/**
 * Re-check every Recent/Pinned path and flag the ones whose file is gone, so a
 * dead row looks dead. Cheap (one stat per entry) and safe to call often.
 */
export async function validateRecentPaths() {
  const paths = [...new Set([...recentFiles(), ...pinnedFiles()])];
  await Promise.all(
    paths.map(async (p) => markMissing(p, !(await pathExists(p)))),
  );
}

/**
 * Open a Recent/Pinned entry whose file has gone missing: say so, and offer to
 * drop it from the list. Returns true when the caller should stop.
 */
async function handleMissingFile(p: string): Promise<boolean> {
  markMissing(p, true);
  const name = fileName0(p);
  if (await confirmDialog(`${name} no longer exists at:\n${p}\n\nRemove it from Recent?`)) {
    await removeRecentFile(p);
    markMissing(p, false);
  }
  return true;
}

export async function openFile(path?: string) {
  const p = path ?? (await pickMarkdownFile());
  if (!p) return;
  const existing = findTabByPath(p);
  if (existing !== undefined) { switchTab(existing); return; }
  // A Recent entry can point at a file that has since been deleted or moved.
  // Without this the invoke below rejects unhandled and the click does nothing.
  if (!(await pathExists(p))) {
    await handleMissingFile(p);
    return;
  }
  let ed: EncodedDoc;
  try {
    ed = await readFileEncoded(p);
  } catch (e) {
    // Raced with a delete, or unreadable for another reason (permissions).
    if (!(await pathExists(p))) {
      await handleMissingFile(p);
      return;
    }
    await alertDialog(String(e));
    return;
  }
  // Offer to recover newer autosaved content from a previous session.
  const shadow = await shadowFor(p, ed.content);
  if (shadow && (await confirmDialog(
    `Sarala has unsaved autosaved changes for ${fileName0(p)} from a previous session. Restore them?`,
  ))) {
    await restoreSession(shadow);
  } else {
    if (shadow) await clearShadow(keyForPath(p));
    await applyOpened(p, ed);
  }
  await addRecentFile(p);
}

const fileName0 = (p: string) => p.replace(/\\/g, "/").split("/").pop() || p;

function newFile() {
  openDocument("", null);
}

/** Conflict banner ▸ Reload: re-read the file from disk, discarding edits. */
export async function reloadFromDisk() {
  const id = activeTabId();
  const path = doc.filePath;
  if (!path) {
    setExternalChange(null);
    return;
  }
  try {
    await applyOpened(path, await readFileEncoded(path), id);
  } catch {
    if (activeTabId() === id) setExternalChange(null);
  }
}

/** Conflict banner ▸ Keep mine: dismiss, re-baseline the watcher to the current
 *  on-disk bytes (so a later external change re-prompts), and mark dirty so the
 *  next save overwrites the external version. */
export async function keepMine() {
  const path = doc.filePath;
  setExternalChange(null);
  setDocDirty(true);
  if (path) await watchFile(path);
}

/** Document bytes-as-text for disk: apply the final-newline policy (Edit ▸ Final
 *  Newline), then line endings (Edit ▸ Line Endings). Both touch only the disk
 *  form — never the in-memory blocks. */
function textForDisk(text = fullText()): string {
  const policy = finalNewline();
  if (policy === "ensure") text = text.length ? text.replace(/\n+$/, "") + "\n" : text;
  else if (policy === "trim") text = text.replace(/\n+$/, "");
  return lineEnding() === "crlf" ? text.replace(/\n/g, "\r\n") : text;
}

async function saveTab(as = false) {
  const id = activeTabId();
  const initial = getTabDocument(id)!;
  const name = initial.filePath ? fileName0(initial.filePath) : "Untitled.md";
  const path = as || !initial.filePath ? await pickSavePath(name) : initial.filePath;
  if (!path && isTauri) return;
  const document = getTabDocument(id);
  if (!document) return;
  const duplicate = path ? findTabByPath(path) : undefined;
  if (duplicate !== undefined && duplicate !== id) {
    await alertDialog("That file is already open in another tab. Choose a different name or save from that tab.");
    return;
  }
  const text = joinBlocks(document.blocks.map((b) => b.text));
  await writeTextFile(path ?? name, textForDisk(text), document.encoding, document.hadBom);
  if (path) {
    markTabSaved(id, path, text);
    if (initial.filePath !== path) await discardShadowFor(initial.filePath);
    await watchFile(path);
    await addRecentFile(path);
    if (as) await refreshTree();
  }
}
export async function save() { await saveTab(); }
async function saveAs() { await saveTab(true); }

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
  if (findTabByPath(to) !== undefined) { await alertDialog("That file is already open in another tab."); return; }
  try {
    await renameFile(from, to);
    retargetTabPath(from, to);
    await watchFile(to);
    await addRecentFile(to);
    await refreshTree();
  } catch (e) {
    await alertDialog(String(e));
  }
}

async function deleteCurrent() {
  const id = activeTabId();
  const path = doc.filePath;
  if (!path) return;
  if (!(await confirmDialog(`Delete ${fileName()}? This cannot be undone.`))) return;
  try {
    await deleteFile(path);
    removeTab(id);
    await discardShadowFor(path);
    await refreshTree();
  } catch (e) {
    await alertDialog(String(e));
  }
}

async function revertToSaved() {
  const id = activeTabId();
  const path = doc.filePath;
  if (!path) return;
  if (doc.dirty && !(await confirmDialog(`Revert ${fileName()} to the last saved version?`))) return;
  await applyOpened(path, await readFileEncoded(path), id);
}

async function importViaPandoc() {
  if (!(await ensurePandoc())) return;
  const path = await pickImportFile();
  if (!path) return;
  try {
    openDocument(await pandocImport(path), null);
    setDocDirty(true);
  } catch (e) {
    await alertDialog(`Pandoc import failed:\n${String(e)}`);
  }
}

// ---------- Export ----------

const EXT: Record<ExportFormat, string> = {
  html: "html", html_plain: "html", pdf: "pdf", docx: "docx", odt: "odt",
  rtf: "rtf", epub: "epub", latex: "tex", mediawiki: "wiki", rst: "rst",
  textile: "textile", opml: "opml",
};
const PANDOC_FORMATS: Partial<Record<ExportFormat, string>> = {
  docx: "docx", odt: "odt", rtf: "rtf", epub: "epub", latex: "latex",
  mediawiki: "mediawiki", rst: "rst", textile: "textile", opml: "opml",
};

/** export_filename YAML override wins; else the document's base name. */
function exportBaseName(): string {
  return readExportOverrides(currentFrontMatter()).filename ?? docBaseName();
}

function loadExportCss(): string {
  // Full app stylesheet (theme variables + .rendered styling + Shiki + math) so
  // exports match the editor; EXPORT_PRINT_CSS forces colors to print and gives
  // the standalone document a centered column.
  return appCssText + EXPORT_PRINT_CSS;
}

/**
 * Render markdown to HTML and bake the async diagram SVGs (mermaid + D2) into
 * it. renderMarkdown emits empty diagram placeholders; the editor fills them
 * live, but exports render synchronously, so we replay the same injection on a
 * detached container here. The diagram engines append temporary measuring nodes
 * to <body> and clean them up themselves; injection targets each placeholder's
 * own innerHTML, so a detached host works.
 */
async function renderBody(md: string): Promise<string> {
  const div = document.createElement("div");
  // Front matter is document metadata, never part of the rendered body.
  const body = stripFrontMatter(md);
  await prepareRender(body); // grammars, KaTeX and emoji load lazily; exports need them now
  div.innerHTML = renderMarkdown(body);
  await renderMermaidIn(div);
  await renderD2In(div);
  return div.innerHTML;
}

/** Embedded @font-face data URIs for the chosen prose/code fonts, so an export
 *  renders the same on a machine that doesn't have them installed. Appended
 *  after the app CSS so its :root overrides win. */
async function fontCss(): Promise<string> {
  return fontEmbedCss(proseFont(), monoFont());
}

/** Build the exported HTML document (outline sidebar when there are headings). */
async function htmlDocument(withStyles: boolean, withOutline: boolean): Promise<string> {
  return buildExportHtml({
    title: exportBaseName(),
    body: await renderBody(fullText()),
    css: withStyles ? loadExportCss() + (await fontCss()) : "",
    theme: theme(),
    withOutline,
    tablesFull: tableFullWidth(),
  });
}

/** Build the print HTML for PDF: matches the editor theme, full-width, no outline. */
async function pdfDocument(): Promise<string> {
  return buildExportHtml({
    title: exportBaseName(),
    body: await renderBody(fullText()),
    css: appCssText + PDF_PRINT_CSS + (await fontCss()),
    theme: theme(),
    withOutline: false,
    tablesFull: tableFullWidth(),
    pageCss: currentPdfCss(),
  });
}

/** Current PDF @page CSS from settings + per-document overrides. */
function currentPdfCss(): string {
  const base = pdfOptions();
  const o = readExportOverrides(currentFrontMatter());
  const opts = {
    pageSize: o.pdfPageSize ?? base.pageSize,
    margin: o.pdfMargin ?? base.margin,
    header: o.pdfHeader ?? base.header,
    footer: o.pdfFooter ?? base.footer,
  };
  return pageCss(opts);
}

/** Run one export to `out`; returns the path written, or null if cancelled. */
async function runExport(
  format: ExportFormat,
  out: string,
  pandocFlags: string[] = [],
  outline = true,
): Promise<string | null> {
  if (format === "html" || format === "html_plain") {
    await writeTextFile(out, await htmlDocument(format === "html", format === "html" && outline));
    return out;
  }
  if (format === "pdf") {
    const html = await pdfDocument();
    try {
      await exportPdf(html, out);
      return out;
    } catch (e) {
      if (String(e).includes("no_chromium")) {
        await alertDialog("PDF export needs Chrome/Chromium installed. Falling back to the print dialog.");
        window.print();
        return null;
      }
      await alertDialog(`PDF export failed:\n${String(e)}`);
      return null;
    }
  }
  const pf = PANDOC_FORMATS[format];
  if (!pf) return null;
  if (!(await ensurePandoc())) return null;
  try {
    await pandocExport(fullText(), out, pf, [...pandocFlagsFor(pf), ...pandocFlags]);
    return out;
  } catch (e) {
    await alertDialog(`Pandoc export failed:\n${String(e)}`);
    return null;
  }
}

/** Menu export (HTML / PDF / a pandoc format): prompt for path, export, remember. */
async function doExport(format: ExportFormat, id: string, presetPath: string | null = null) {
  // Styled HTML export asks whether to include the outline sidebar.
  let outline = true;
  if (format === "html" && !presetPath) {
    const choice = await askHtmlOutline();
    if (choice === null) return; // cancelled
    outline = choice;
  }
  const out = presetPath ?? (await pickSavePath(`${exportBaseName()}.${EXT[format]}`));
  if (!out && isTauri) return;
  const written = await runExport(format, out ?? `${exportBaseName()}.${EXT[format]}`, [], outline);
  if (written) await setLastExport({ id, path: written });
}

export async function exportHtml() {
  await doExport("html", "file.export.html");
}

// ---------- presets ----------

/** Run a named preset: resolve its output path, export, run the after-action. */
export async function runPreset(preset: ExportPreset) {
  const dir = docDir() ?? "";
  const base = exportBaseName();
  const ext = EXT[preset.format];
  let out: string | null;
  if (preset.outputPath) {
    out = resolveOutputPath(preset.outputPath, { dir, name: base, ext });
  } else {
    out = await pickSavePath(`${base}.${ext}`);
    if (!out) return;
  }
  const written = await runExport(preset.format, out, preset.pandocFlags ?? []);
  if (!written) return;
  await setLastExport({ id: `preset:${preset.name}`, path: written, presetName: preset.name });

  switch (preset.after) {
    case "reveal":
      await revealInDir(written);
      break;
    case "open":
      await openExternal(written);
      break;
    case "run":
      if (preset.command) {
        try {
          await runCommand(preset.command.replace(/\$\{output\}/g, written));
        } catch (e) {
          await alertDialog(`Post-export command failed:\n${String(e)}`);
        }
      }
      break;
  }
}

async function exportPrevious() {
  const memo = lastExport();
  if (!memo) {
    await alertDialog("No previous export to repeat.");
    return;
  }
  if (memo.presetName) {
    const preset = exportPresets().find((p) => p.name === memo.presetName);
    if (preset) return runPreset(preset);
  }
  const format = memo.id.replace("file.export.", "") as ExportFormat;
  await doExport(format in EXT ? format : "html", memo.id, memo.path);
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

/**
 * Insert a fresh block after the target (or at the end) and focus it. An empty
 * target block *becomes* the new block instead of being left behind above it —
 * that is what the slash menu needs (it fires from an otherwise-blank line),
 * and it is what the Paragraph menu should have been doing all along.
 */
function insertBlock(text: string, caretWithin = text.length) {
  const at = targetBlockIndex();
  requestCaret(caretWithin);
  if (at >= 0 && doc.blocks[at].text.trim() === "") updateBlock(at, text);
  else insertBlockAfter(at >= 0 ? at : doc.blocks.length - 1, text);
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
  let caret = Math.min(blockApi?.caretOffset() ?? 0, next.length);
  if (edit.kind === "move_row" || edit.kind === "move_col") {
    const oldOffset = blockApi?.caretOffset() ?? 0;
    const line = lineAtOffset(text, oldOffset);
    const row = Math.max(0, line - 1) + (edit.kind === "move_row" ? edit.direction : 0);
    const column = columnAtOffset(text, oldOffset) + (edit.kind === "move_col" ? edit.direction : 0);
    caret = cellRanges(next)[row * parseTable(next)!.align.length + column]?.start ?? caret;
  }
  requestCaret(caret);
  updateBlock(i, next);
}

const moveWritingRow = (direction: -1 | 1) => {
  const index = targetBlockIndex();
  if (index < 0) return;
  if (parseTable(doc.blocks[index].text)) applyTableEdit({ kind: "move_row", direction });
  else moveBlock(index, direction);
};

const tableAlign = (align: Align) => () => applyTableEdit({ kind: "align", align });

/**
 * Grow the active table from its edge "+" rails, landing the caret in the new
 * cell. `cellRanges` is recomputed on the *new* source, so the tab-order index
 * the append reports resolves to a real offset.
 */
function growActiveTable(grow: (text: string) => TableAppend | null) {
  const i = targetBlockIndex();
  if (i < 0) return;
  const text = doc.blocks[i].text;
  const next = grow(text);
  if (next == null || next.text === text) return;
  const cell = cellRanges(next.text)[next.cell];
  requestCaret(cell ? cell.end : next.text.length);
  updateBlock(i, next.text);
}

export const appendRowToActiveTable = () => growActiveTable(appendTableRow);
export const appendColumnToActiveTable = () => growActiveTable(appendTableColumn);

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

/** Copy the active table's Markdown source to the clipboard. */
async function copyActiveTable() {
  const i = targetBlockIndex();
  if (i < 0 || !parseTable(doc.blocks[i].text)) return;
  await clipboardWriteText(doc.blocks[i].text);
}

/** Realign the active table's pipes so its source reads cleanly. */
function prettifyActiveTable() {
  const i = targetBlockIndex();
  if (i < 0) return;
  const text = doc.blocks[i].text;
  const next = prettifyTable(text);
  if (next == null || next === text) return;
  requestCaret(Math.min(blockApi?.caretOffset() ?? 0, next.length));
  updateBlock(i, next);
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
  const text = stripControlChars(await clipboardReadText());
  if (text && blockApi) blockApi.insertAtCaret(text);
}

/** Regular paste from the context menu: insert clipboard text at the caret. */
async function pasteText() {
  const text = await clipboardReadText();
  if (text && blockApi) blockApi.insertAtCaret(text);
}

/** Copy the visible (formatted-away) text: the current selection if there is
 *  one, else the whole document rendered to plain text. */
async function copyPlain() {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed) {
    await clipboardWriteText(sel.toString());
    return;
  }
  const tmp = document.createElement("div");
  tmp.innerHTML = await renderBody(fullText());
  await clipboardWriteText((tmp.textContent ?? "").trim());
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

async function chooseFinalNewline(v: "ensure" | "preserve" | "trim") {
  setFinalNewline(v);
  await setSetting("finalNewline", v);
}

async function chooseAutosaveInterval(seconds: number) {
  setAutosaveInterval(seconds);
  await setSetting("autosaveInterval", seconds);
}

/** Re-decode the current file with a chosen encoding (Edit ▸ Reopen with
 *  Encoding). `utf8_bom` keeps UTF-8 but forces a BOM on the next save. */
async function reopenEncoding(idLabel: string) {
  const id = activeTabId();
  const path = doc.filePath;
  if (!path) {
    await alertDialog("Open a file before choosing an encoding.");
    return;
  }
  if (doc.dirty && !(await confirmDialog(`Reopen ${fileName()} with a different encoding? Unsaved changes will be lost.`))) {
    return;
  }
  try {
    if (idLabel === "utf8_bom") {
      const ed = await reopenWithEncoding(path, "UTF-8");
      replaceTabDocument(id, ed.content, path, { encoding: "UTF-8", hadBom: true }, ed.lossy);
    } else {
      const ed = await reopenWithEncoding(path, idLabel);
      replaceTabDocument(id, ed.content, path, ed, ed.lossy);
    }
    await watchFile(path);
  } catch (e) {
    await alertDialog(String(e));
  }
}

async function toggleMathAltDelimiters() {
  const v = !mathAltDelimiters();
  setMathAltDelimitersSig(v);
  setMathAltDelimitersOpt(v);
  bumpRenderEpoch();
  await setSetting("mathAltDelimiters", v);
}

async function toggleMathFence() {
  const v = !mathFence();
  setMathFenceSig(v);
  setMathFenceOpt(v);
  bumpRenderEpoch();
  await setSetting("mathFence", v);
}

async function toggleHighlightExt() {
  const v = !highlightEnabled();
  setHighlightEnabledSig(v);
  setHighlightEnabledOpt(v);
  setLiveHighlight(v);
  bumpRenderEpoch();
  await setSetting("highlightEnabled", v);
}

async function toggleSubSupExt() {
  const v = !subSupEnabled();
  setSubSupEnabledSig(v);
  setSubSupEnabledOpt(v);
  setLiveSubSup(v);
  bumpRenderEpoch();
  await setSetting("subSupEnabled", v);
}

async function toggleEmojiExt() {
  const v = !emojiEnabled();
  setEmojiEnabledSig(v);
  setEmojiEnabledOpt(v);
  bumpRenderEpoch();
  await setSetting("emojiEnabled", v);
}

async function toggleAutolinkExt() {
  const v = !autolinkEnabled();
  setAutolinkEnabledSig(v);
  setAutolinkEnabledOpt(v);
  bumpRenderEpoch();
  await setSetting("autolinkEnabled", v);
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

/**
 * Follow a link from the rendered view.
 *
 * A relative link to a sibling document used to be handed straight to the OS
 * opener, which gets a schemeless path with no notion of the document's folder
 * and silently does nothing — clicking `RELEASING.md` from the README did
 * nothing at all. Resolve first, then route: documents open in the editor,
 * other local files go to the desktop, and `#anchors` scroll this document.
 */
export async function followLink(href: string) {
  const dest = linkDestination(href);
  switch (dest.kind) {
    case "external":
      await openExternal(dest.url);
      return;
    case "document":
      if (!(await pathExists(dest.path))) {
        await alertDialog(`That file no longer exists:\n${dest.path}`);
        return;
      }
      await openFile(dest.path);
      return;
    case "file":
      if (!(await pathExists(dest.path))) {
        await alertDialog(`That file no longer exists:\n${dest.path}`);
        return;
      }
      await openExternal(dest.path);
      return;
    case "anchor": {
      // Slugs are generated by the renderer's addHeadingIds, so match on them.
      const el = document.getElementById(dest.id);
      el?.scrollIntoView({ block: "start" });
      return;
    }
    default:
      return;
  }
}

/* ---------- sidebar file operations ----------
   These act on any path in the tree, unlike the `file.*` commands which act on
   the open document. Each refreshes the tree; expansion state is keyed by path
   in the store, so it survives that refresh. */

/** Rename/move a file from the tree. Retargets the editor if it was open. */
export async function renamePath(path: string) {
  const to = await pickSavePath(path.replace(/\\/g, "/").split("/").pop() ?? "");
  if (!to || to === path) return;
  if (findTabByPath(to) !== undefined) { await alertDialog("That file is already open in another tab."); return; }
  try {
    await renameFile(path, to);
    retargetTabPath(path, to);
    await watchFile(to);
    await addRecentFile(to);
    await refreshTree();
  } catch (e) {
    await alertDialog(String(e));
  }
}

/** Delete a file from the tree, after confirming. */
export async function deletePath(path: string) {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? path;
  if (!(await confirmDialog(`Delete ${name}? This cannot be undone.`))) return;
  try {
    await deleteFile(path);
    // The open document just lost its file; keep the buffer but forget the path
    // so the next save prompts for a location rather than recreating it.
    retargetTabPath(path, null);
    await refreshTree();
  } catch (e) {
    await alertDialog(String(e));
  }
}

export async function revealPath(path: string) {
  try {
    await revealInDir(path);
  } catch (e) {
    await alertDialog(String(e));
  }
}

export const copyPath = (path: string) => clipboardWriteText(path);

/** Create a new markdown file next to `nearPath` (or inside it, if a folder). */
export async function newFileNear(nearPath: string, isDir: boolean) {
  const norm = nearPath.replace(/\\/g, "/");
  const dir = isDir ? norm : norm.slice(0, norm.lastIndexOf("/"));
  // pickSavePath forwards its argument as Tauri's `defaultPath`, which accepts a
  // full path — so joining the directory here is what opens the dialog there.
  const to = await pickSavePath(dir ? `${dir}/Untitled.md` : "Untitled.md");
  if (!to) return;
  try {
    await writeTextFile(to, "");
    await refreshTree();
    await openFile(to);
  } catch (e) {
    await alertDialog(String(e));
  }
}

/* ---------- slash menu ---------- */

/** Insert a fenced block with a starter body, caret at the end of the body. */
export function insertFencedBlock(lang: string, body: string) {
  const head = "```" + lang + "\n";
  insertBlock(head + body + "\n```", head.length + body.length);
}

/**
 * Delete [start, end) from the target block, parking the caret at `start`.
 * The slash menu uses this to remove the `/query` before running an item, so
 * the item's own command sees a clean block.
 */
export function deleteRangeInBlock(start: number, end: number) {
  const i = targetBlockIndex();
  if (i < 0) return;
  const text = doc.blocks[i].text;
  const from = Math.max(0, Math.min(start, text.length));
  const to = Math.max(from, Math.min(end, text.length));
  if (to === from) return;
  requestCaret(from);
  updateBlock(i, text.slice(0, from) + text.slice(to));
}

/* ---------- selection toolbar ---------- */

/**
 * Toggle an inline mark over the current selection, keeping the selection on
 * the same words afterwards. `wrap()` (the menu/keyboard path) collapses the
 * caret instead, which would dismiss the floating toolbar on every click.
 */
export function toggleInlineMark(kind: Exclude<MarkKind, "image">) {
  const i = targetBlockIndex();
  if (i < 0 || !blockApi) return;
  const { start, end } = blockApi.selectionOffsets();
  if (end <= start) return;
  const text = doc.blocks[i].text;
  const edit = toggleMark(text, start, end, kind);
  if (edit.text === text) return;
  requestSelection(edit.start, edit.end);
  updateBlock(i, edit.text);
}

/** Convert the target block to a block construct, preserving the selection. */
export function setBlockKind(kind: BlockKind) {
  const i = targetBlockIndex();
  if (i < 0) return;
  const text = doc.blocks[i].text;
  const edit = applyBlockKind(text, kind);
  if (edit.text === text) return;
  const sel = blockApi?.selectionOffsets();
  if (sel && sel.end > sel.start) requestSelection(edit.map(sel.start), edit.map(sel.end));
  else requestCaret(edit.map(sel?.start ?? text.length));
  updateBlock(i, edit.text);
}

/**
 * Markdown ref for an inserted image. Copies it next to the document when
 * enabled — the folder template (global setting or the per-document
 * `copy-images-to` front-matter override) expands ${filename} to the
 * doc's base name. Otherwise the path is relativized against the doc dir.
 */
export async function imageInsertRef(absPath: string): Promise<string> {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const dir = docDir();
  const fm = currentFrontMatter();
  // copy-images-to enables copy for the document even if the global toggle
  // is off. Copying needs a doc dir to copy into.
  const template = fm["copy-images-to"] ?? fm["typora-copy-images-to"] ?? (copyImageToAssets() ? copyImagesToFolder() : null);
  if (dir && template) {
    const folder = template.replace(/\$\{filename\}/g, docBaseName());
    try {
      return await copyAsset(absPath, dir, folder);
    } catch (e) {
      await alertDialog(String(e));
    }
  }
  // When an image root is set and the file lives under it, store a
  // root-relative link (/rel) — it resolves against the root and works even
  // for unsaved documents (which have no doc dir to be relative to).
  const root = fm["image-root-url"] ?? fm["typora-root-url"];
  if (root) {
    const r = norm(root).replace(/\/+$/, "");
    if (norm(absPath).startsWith(r + "/")) return "/" + norm(absPath).slice(r.length + 1);
  }
  // Otherwise store relative to the document folder when the file is under it.
  if (dir && norm(absPath).startsWith(norm(dir) + "/")) return norm(absPath).slice(norm(dir).length + 1);
  return absPath;
}

/** Insert an image reference, honoring the copy-to-folder rules. */
export async function insertImageFromPath(absPath: string) {
  const ref = await imageInsertRef(absPath);
  // A destination with spaces must be wrapped in <> to be valid markdown.
  const dest = /\s/.test(ref) ? `<${ref}>` : ref;
  const md = `![](${dest})`;
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
  "menu.command_palette": () => { setCommandPaletteVisible(true); },
  "file.open_folder": openFolder,
  "file.open_recent.clear": () => clearRecentFiles(),
  "file.close": () => closeTab(),
  "window.next_tab": () => cycleTab(1),
  "window.previous_tab": () => cycleTab(-1),
  "file.save": save,
  "file.save_as": saveAs,
  "file.rename": renameCurrent,
  "file.delete": deleteCurrent,
  "file.revert.last_saved": revertToSaved,
  "file.import": importViaPandoc,
  "file.export.previous": exportPrevious,
  "file.print": () => { window.print(); },

  // Edit
  "edit.undo": undo,
  "edit.redo": redo,
  "edit.copy_markdown": copyAsMarkdown,
  "edit.copy_html": async () => clipboardWriteText(await renderBody(fullText())),
  "edit.copy_plain": copyPlain,
  "edit.paste": pasteText,
  "edit.paste_plain": pastePlain,
  "edit.move_row_up": () => moveWritingRow(-1),
  "edit.move_row_down": () => moveWritingRow(1),
  "edit.delete_block": () => { if (doc.activeIndex >= 0) removeBlock(doc.activeIndex); },
  "edit.select_block": () => {
    if (doc.activeIndex >= 0) blockApi?.selectRange(0, doc.blocks[doc.activeIndex].text.length);
  },
  "edit.select_all": () => selectAllDocument(),
  "edit.select_line": selectLine,
  "edit.select_word": selectWord,
  "edit.find": () => { openFind(false); },
  "edit.find_next": () => { findNext(1); },
  "edit.replace": () => { openFind(true); },
  "edit.smart_punctuation": toggleSmartPunctuation,
  "edit.spellcheck": toggleSpellcheck,
  "edit.line_ending.lf": () => chooseLineEnding("lf"),
  "edit.line_ending.crlf": () => chooseLineEnding("crlf"),
  "edit.final_newline.ensure": () => chooseFinalNewline("ensure"),
  "edit.final_newline.preserve": () => chooseFinalNewline("preserve"),
  "edit.final_newline.trim": () => chooseFinalNewline("trim"),
  "edit.autosave.off": () => chooseAutosaveInterval(0),
  "edit.autosave.5": () => chooseAutosaveInterval(5),
  "edit.autosave.15": () => chooseAutosaveInterval(15),
  "edit.autosave.30": () => chooseAutosaveInterval(30),
  "edit.preserve_breaks": togglePreserveBreaks,
  "edit.math.alt_delimiters": toggleMathAltDelimiters,
  "edit.math.fence": toggleMathFence,
  "edit.ext.highlight": toggleHighlightExt,
  "edit.ext.sub_sup": toggleSubSupExt,
  "edit.ext.emoji": toggleEmojiExt,
  "edit.ext.autolink": toggleAutolinkExt,

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
  "paragraph.table.move_row_up": () => applyTableEdit({ kind: "move_row", direction: -1 }),
  "paragraph.table.move_row_down": () => applyTableEdit({ kind: "move_row", direction: 1 }),
  "paragraph.table.move_col_left": () => applyTableEdit({ kind: "move_col", direction: -1 }),
  "paragraph.table.move_col_right": () => applyTableEdit({ kind: "move_col", direction: 1 }),
  "paragraph.table.delete_row": () => applyTableEdit({ kind: "delete_row" }),
  "paragraph.table.add_col": () => applyTableEdit({ kind: "add_col" }),
  "paragraph.table.add_col_before": () => applyTableEdit({ kind: "add_col", before: true }),
  "paragraph.table.delete_col": () => applyTableEdit({ kind: "delete_col" }),
  "paragraph.table.copy": () => void copyActiveTable(),
  "paragraph.table.prettify": prettifyActiveTable,
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
  "paragraph.alert.important": () => insertBlock("> [!IMPORTANT]\n> "),
  "paragraph.alert.warning": () => insertBlock("> [!WARNING]\n> "),
  "paragraph.alert.caution": () => insertBlock("> [!CAUTION]\n> "),

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
  "format.image.root_path": () => void setImageRootPath(),
  "format.clear": clearFormat,
  "themes.picker": () => openThemePicker(),
  "themes.custom": () => openThemeEditor(),

  // View
  "view.source_mode": () => { setSourceMode(!sourceMode()); },
  "view.sidebar": () => { setSidebarOpen(!sidebarOpen()); },
  "view.file_tree": () => { setSidebarOpen(true); setSidebarTab("files"); },
  "view.outline": () => { setSidebarOpen(true); setSidebarTab("outline"); },
  "view.search": () => { openFind(false); },
  "view.focus_mode": () => { setFocusMode(!focusMode()); },
  "view.typewriter_mode": () => { setTypewriterMode(!typewriterMode()); },
  "view.status_bar": () => {
    const v = !statusBarVisible();
    setStatusBarVisible(v);
    void setSetting("statusBarVisible", v);
  },
  "view.zoom_in": () => changeZoom(zoom() + 10),
  "view.zoom_out": () => changeZoom(zoom() - 10),
  "view.zoom_actual": () => changeZoom(100),
  "view.always_on_top": async () => {
    const v = !alwaysOnTop();
    setAlwaysOnTop(v);
    await setWindowAlwaysOnTop(v);
  },
  "view.fullscreen": () => toggleFullscreen(),

  // Window (in-app menubar on Linux/Windows; macOS uses native Window menu)
  "window.minimize": () => minimizeWindow(),
  "window.maximize": () => toggleMaximizeWindow(),

  // Help
  "help.readme": () => openExternal(HELP_URL),
  "help.about": () => openAbout(),
  "help.check_updates": () => checkForUpdates(),

  // Settings
  "app.settings": () => openSettings(),
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
// Map each export menu id to its format.
const EXPORT_MENU: Record<string, ExportFormat> = {
  "file.export.html": "html", "file.export.html_plain": "html_plain",
  "file.export.pdf": "pdf", "file.export.docx": "docx", "file.export.odt": "odt",
  "file.export.rtf": "rtf", "file.export.epub": "epub", "file.export.latex": "latex",
  "file.export.mediawiki": "mediawiki", "file.export.rst": "rst",
  "file.export.textile": "textile", "file.export.opml": "opml",
};
for (const [id, format] of Object.entries(EXPORT_MENU)) {
  registry[id] = () => doExport(format, id);
}

export function executeCommand(id: string) {
  if (id.startsWith("edit.encoding.")) {
    void reopenEncoding(id.slice("edit.encoding.".length));
    return;
  }
  const recent = id.match(/^file\.open_recent\.item\.(\d+)$/);
  if (recent) {
    const path = recentFiles()[Number(recent[1])];
    if (path) void openFile(path);
    return;
  }
  const preset = id.match(/^file\.export\.preset\.(\d+)$/);
  if (preset) {
    const p = exportPresets()[Number(preset[1])];
    if (p) void runPreset(p);
    return;
  }
  const command = registry[id];
  if (!command) {
    console.warn("TODO: unimplemented menu command", id);
    return;
  }
  void command();
}
