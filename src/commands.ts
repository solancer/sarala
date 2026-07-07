import {
  doc, fullText, fileName, loadDocument, markSaved, setFilePath, setHeading,
  sourceMode, setSourceMode, sidebarOpen, setSidebarOpen,
  theme, setTheme, THEMES, setFileTree, setFolderName,
  folderPath, setFolderPath, setQuickOpenVisible, setCommandPaletteVisible,
  moveBlock, removeBlock, updateBlock, insertBlockAfter, appendBlock,
  targetBlockIndex, requestCaret, undo, redo, setCaretProvider,
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
  bumpRenderEpoch, proseFont, monoFont,
} from "./store";
import { selectAllDocument } from "./blockselect";
import { fontEmbedCss } from "./fonts";
import {
  isTauri, pickFolder, pickMarkdownFile, pickSavePath, pickImportFile,
  readFileEncoded, reopenWithEncoding, writeTextFile, type EncodedDoc,
  watchFile, clearShadow, listDirectory, openExternal,
  confirmDialog, alertDialog, renameFile, deleteFile, openNewWindow,
  pandocImport, pandocExport, exportPdf, runCommand, revealInDir,
  clipboardWriteText, clipboardReadText,
  pickImageFile, copyAsset,
  setWindowAlwaysOnTop, toggleFullscreen, minimizeWindow, toggleMaximizeWindow,
} from "./platform";
import {
  renderMarkdown, setPreserveBreaksOption,
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
import { shadowFor, restoreSession, keyForPath } from "./autosave";
import { stripControlChars } from "./richpaste";
import {
  recentFiles, addRecentFile, clearRecentFiles, lastExport, setLastExport,
  exportPresets, pdfOptions, setSetting,
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
import { checkForUpdates } from "./updater";
import { skeletonTable, editTable, resizeTable, prettifyTable, parseTable, type TableEdit, type Align } from "./tabletools";

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

/** True when it is safe to discard the current document. */
async function confirmDiscard(): Promise<boolean> {
  if (!doc.dirty) return true;
  return confirmDialog(`Discard unsaved changes to ${fileName()}?`);
}

/** Load a decoded file into the editor, flag lossy decodes, and start watching
 *  it for external changes (clearing any stale conflict banner). */
async function applyOpened(p: string, ed: EncodedDoc) {
  loadDocument(ed.content, p, { encoding: ed.encoding, hadBom: ed.hadBom });
  setEncodingLossy(ed.lossy);
  setExternalChange(null);
  await watchFile(p);
}

export async function openFile(path?: string) {
  const p = path ?? (await pickMarkdownFile());
  if (!p) return;
  const ed = await readFileEncoded(p);
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

async function newFile() {
  if (await confirmDiscard()) loadDocument("", null);
}

/** Conflict banner ▸ Reload: re-read the file from disk, discarding edits. */
export async function reloadFromDisk() {
  const path = doc.filePath;
  if (!path) {
    setExternalChange(null);
    return;
  }
  try {
    await applyOpened(path, await readFileEncoded(path));
  } catch {
    setExternalChange(null);
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
function textForDisk(): string {
  let text = fullText();
  const policy = finalNewline();
  if (policy === "ensure") text = text.length ? text.replace(/\n+$/, "") + "\n" : text;
  else if (policy === "trim") text = text.replace(/\n+$/, "");
  return lineEnding() === "crlf" ? text.replace(/\n/g, "\r\n") : text;
}

export async function save() {
  let path = doc.filePath;
  if (!path) path = await pickSavePath(fileName());
  if (!path && isTauri) return;
  await writeTextFile(path ?? fileName(), textForDisk(), doc.encoding, doc.hadBom);
  if (path) {
    markSaved(path);
    setExternalChange(null);
    await watchFile(path);
    await addRecentFile(path);
  }
}

async function saveAs() {
  const path = await pickSavePath(fileName());
  if (!path && isTauri) return;
  await writeTextFile(path ?? fileName(), textForDisk(), doc.encoding, doc.hadBom);
  if (path) {
    markSaved(path);
    setExternalChange(null);
    await watchFile(path);
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
  await applyOpened(path, await readFileEncoded(path));
}

async function importViaPandoc() {
  if (!(await ensurePandoc())) return;
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
  div.innerHTML = renderMarkdown(stripFrontMatter(md));
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
      loadDocument(ed.content, path, { encoding: "UTF-8", hadBom: true });
      setEncodingLossy(ed.lossy);
    } else {
      const ed = await reopenWithEncoding(path, idLabel);
      loadDocument(ed.content, path, { encoding: ed.encoding, hadBom: ed.hadBom });
      setEncodingLossy(ed.lossy);
    }
    setExternalChange(null);
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
  const template = fm["copy-images-to"] ?? (copyImageToAssets() ? copyImagesToFolder() : null);
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
  const root = fm["image-root-url"];
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
  "edit.undo": undo,
  "edit.redo": redo,
  "edit.copy_markdown": copyAsMarkdown,
  "edit.copy_html": async () => clipboardWriteText(await renderBody(fullText())),
  "edit.copy_plain": copyPlain,
  "edit.paste": pasteText,
  "edit.paste_plain": pastePlain,
  "edit.move_row_up": () => { if (doc.activeIndex >= 0) moveBlock(doc.activeIndex, -1); },
  "edit.move_row_down": () => { if (doc.activeIndex >= 0) moveBlock(doc.activeIndex, 1); },
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
  "format.image.root_path": () => void setImageRootPath(),
  "format.clear": clearFormat,

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
