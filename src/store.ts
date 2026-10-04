import { batch, createSignal, createMemo } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { FileNode } from "./platform";
import type { Base16Scheme } from "./base16";
import { onAssetsReady } from "./assets";
import {
  splitBlocks,
  joinBlocks,
  hasOpenFence,
  countWords,
  setTocProvider,
  setRenderContextProvider,
  buildRenderContext,
  type Heading,
} from "./markdown";

export interface Block {
  id: number;
  text: string;
}

let nextId = 1;
const mkBlock = (text: string): Block => ({ id: nextId++, text });

const [state, setState] = createStore({
  // Launch into a blank Untitled document (same as File ▸ New), not a sample.
  blocks: [mkBlock("")] as Block[],
  activeIndex: -1 as number,
  filePath: null as string | null,
  dirty: false,
  // Encoding the document was read in / will be written back in (Data Safety).
  // The buffer is always UTF-8 in memory; these drive the byte-level save.
  encoding: "UTF-8" as string,
  hadBom: false,
});

// eslint-disable-next-line solid/reactivity -- store proxy re-export; consumers read it in tracked scopes
export const doc = state;

export const THEMES = [
  "sarala", "pro", "octagon", "machine", "ristretto", "spectrum", "classic",
  "paper", "graphite", "github", "night", "newsprint", "whitey",
  // Derived at runtime from a base16 scheme rather than hand-authored in CSS.
  "custom",
] as const;
export type ThemeId = (typeof THEMES)[number];

export const [theme, setTheme] = createSignal<ThemeId>("sarala");

/** The base16 scheme backing the "custom" theme (null until one is imported). */
export const [customScheme, setCustomScheme] = createSignal<Base16Scheme | null>(null);
export const [sourceMode, setSourceMode] = createSignal(false);
export const [sidebarOpen, setSidebarOpen] = createSignal(true);
export const [sidebarTab, setSidebarTab] = createSignal<"files" | "outline" | "search">("files");
/** Sidebar width in px, clamped to 180–480 (drag resize). */
export const [sidebarWidth, setSidebarWidth] = createSignal(240);
export const clampSidebar = (w: number) => Math.max(180, Math.min(480, Math.round(w)));
export const [focusMode, setFocusMode] = createSignal(false);
export const [typewriterMode, setTypewriterMode] = createSignal(false);
// Bottom status bar visibility (persisted via settings).
export const [statusBarVisible, setStatusBarVisible] = createSignal(true);
export const [alwaysOnTop, setAlwaysOnTop] = createSignal(false);
/** Page zoom in percent, clamped to 90–180. */
export const [zoom, setZoom] = createSignal(100);
export const clampZoom = (z: number) => Math.max(90, Math.min(180, z));

// Workspace folder shown in the sidebar (lifted out of App so the command
// bus can drive "Open Folder…").
export const [fileTree, setFileTree] = createSignal<FileNode[]>([]);

/**
 * Expanded folders, keyed by path.
 *
 * Deliberately NOT per-row component state: `refreshTree()` replaces the whole
 * FileNode array with fresh objects from Rust, so Solid recreates every row —
 * signals held inside a row would reset, collapsing the tree on every Save As /
 * Rename / Delete. Keying by path survives that, and survives a restart once
 * persisted.
 */
export const [openFolders, setOpenFolders] = createSignal<ReadonlySet<string>>(new Set());
export const isFolderOpen = (path: string) => openFolders().has(path);
export function setFolderOpen(path: string, open: boolean) {
  setOpenFolders((prev) => {
    if (prev.has(path) === open) return prev;
    const next = new Set(prev);
    if (open) next.add(path);
    else next.delete(path);
    return next;
  });
}
export const toggleFolder = (path: string) => setFolderOpen(path, !isFolderOpen(path));
/** Open every folder on a path's ancestor chain (used by reveal-active-file). */
export function openAncestors(filePath: string, root: string | null) {
  const norm = (p: string) => p.replace(/\\/g, "/");
  const file = norm(filePath);
  const base = root ? norm(root) : "";
  if (base && !file.startsWith(base + "/")) return;
  const rel = base ? file.slice(base.length + 1) : file;
  const segs = rel.split("/").slice(0, -1);
  if (!segs.length) return;
  setOpenFolders((prev) => {
    const next = new Set(prev);
    let acc = base;
    for (const seg of segs) {
      acc = acc ? `${acc}/${seg}` : seg;
      next.add(acc);
    }
    return next;
  });
}
export function collapseAllFolders() {
  setOpenFolders(new Set<string>());
}
/**
 * Recent/Pinned paths whose file no longer resolves on disk. Entries are marked
 * rather than dropped: an unplugged external drive or an unmounted network
 * share would otherwise silently destroy the list, and the file comes back.
 */
export const [missingFiles, setMissingFiles] = createSignal<ReadonlySet<string>>(new Set<string>());
export const isMissing = (path: string) => missingFiles().has(path);
export function markMissing(path: string, missing: boolean) {
  setMissingFiles((prev) => {
    if (prev.has(path) === missing) return prev;
    const next = new Set(prev);
    if (missing) next.add(path);
    else next.delete(path);
    return next;
  });
}

export const [folderName, setFolderName] = createSignal<string | null>(null);
export const [folderPath, setFolderPath] = createSignal<string | null>(null);
export const [quickOpenVisible, setQuickOpenVisible] = createSignal(false);
export const [commandPaletteVisible, setCommandPaletteVisible] = createSignal(false);

// Chosen system fonts (null = theme default). Persisted in settings; applied to
// the --font-prose / --font-mono CSS variables and embedded into exports.
export const [proseFont, setProseFont] = createSignal<string | null>(null);
export const [monoFont, setMonoFont] = createSignal<string | null>(null);

// Edit-menu toggles (persisted in settings).
export const [spellcheckOn, setSpellcheckOn] = createSignal(true);
export const [smartPunctuation, setSmartPunctuation] = createSignal(false);
export const [preserveBreaks, setPreserveBreaks] = createSignal(false);
export const [lineEnding, setLineEnding] = createSignal<"lf" | "crlf">("lf");
// Trailing-newline policy applied only at disk-write time (textForDisk), never
// to in-memory blocks. "ensure" = exactly one; "trim" = none; "preserve" = leave.
export const [finalNewline, setFinalNewline] =
  createSignal<"ensure" | "preserve" | "trim">("ensure");
// Autosave shadow cadence in seconds; 0 disables. Drives the autosave loop.
export const [autosaveInterval, setAutosaveInterval] = createSignal(5);

// An external change to the open file detected by the Rust watcher: drives the
// reload-or-keep conflict banner. `deleted` = the file vanished on disk.
export const [externalChange, setExternalChange] =
  createSignal<{ path: string; deleted: boolean } | null>(null);
// True when the last decode produced replacement chars — the status bar flags
// it so the user can repick via Edit ▸ Reopen with Encoding.
export const [encodingLossy, setEncodingLossy] = createSignal(false);

// Format ▸ Image: copy inserted local images next to the doc. The folder is a
// template supporting ${filename} (the doc's base name); a per-document
// `copy-images-to` front-matter key overrides it.
export const [copyImageToAssets, setCopyImageToAssets] = createSignal(false);
export const [copyImagesToFolder, setCopyImagesToFolder] = createSignal("assets");

// Tables stretch to the page column instead of sizing to their content.
export const [tableFullWidth, setTableFullWidth] = createSignal(false);

// Math rendering preferences (gated, off by default; persisted).
export const [mathAltDelimiters, setMathAltDelimitersSig] = createSignal(false);
export const [htmlEmbeds, setHtmlEmbedsSig] = createSignal(false);
export const [physicsEnabled, setPhysicsEnabledSig] = createSignal(false);
export const [mathAutoNumber, setMathAutoNumberSig] = createSignal(false);
export const [imageUploadUrl, setImageUploadUrl] = createSignal("");
export const [mathFence, setMathFenceSig] = createSignal(false);

// Inline-syntax preferences (on by default; persisted).
export const [emojiEnabled, setEmojiEnabledSig] = createSignal(true);
export const [highlightEnabled, setHighlightEnabledSig] = createSignal(true);
export const [subSupEnabled, setSubSupEnabledSig] = createSignal(true);
export const [autolinkEnabled, setAutolinkEnabledSig] = createSignal(true);

// Bumped when a global render option changes so rendered blocks re-render.
export const [renderEpoch, setRenderEpoch] = createSignal(0);
export const bumpRenderEpoch = () => setRenderEpoch((n) => n + 1);

// Bumped when lazily loaded render data (grammars, KaTeX, emoji) arrives;
// re-renders only the blocks that use it (see buildRenderContext).
export const [assetEpoch, setAssetEpoch] = createSignal(0);
onAssetsReady(() => setAssetEpoch((n) => n + 1));

// Bumped when the theme changes so mermaid diagrams re-render in the new theme.
export const [mermaidEpoch, setMermaidEpoch] = createSignal(0);
export const bumpMermaidEpoch = () => setMermaidEpoch((n) => n + 1);

export const fullText = createMemo(() => joinBlocks(state.blocks.map((b) => b.text)));
/**
 * Document-wide render context, rebuilt once per document change (per-block
 * facts are cached by text, so this is a cheap O(blocks) pass). Blocks read
 * their own `sig` from it and re-render only when that changes.
 */
export const renderContext = createMemo(() => {
  renderEpoch();
  return buildRenderContext(state.blocks, state.filePath, String(assetEpoch()));
});
// Structural equality: typing in a paragraph must not hand the sidebar a new
// outline array (and rebuild every row) when no heading changed.
const sameOutline = (a: Heading[], b: Heading[]) =>
  a.length === b.length && a.every((h, i) => h.level === b[i].level && h.text === b[i].text && h.blockIndex === b[i].blockIndex);
export const outline = createMemo(() => renderContext().outline, [], { equals: sameOutline });
// eslint-disable-next-line solid/reactivity -- the provider runs inside Block's render (a tracked scope)
setTocProvider(() => outline());
// eslint-disable-next-line solid/reactivity -- read inside Block's keyed render
setRenderContextProvider(() => renderContext());
export const stats = createMemo(() => countWords(fullText()));
/** Estimated reading time in whole minutes (200 wpm), never below 1. */
export const readTime = createMemo(() => Math.max(1, Math.ceil(stats().words / 200)));

// Caret position, surfaced as Ln/Col in the status bar. Live mode reports the
// active block index + in-block offset (set from Block's caret tracking);
// Source mode reports {line,col} directly from the textarea. joinBlocks glues
// blocks with "\n\n", so each earlier block adds its own newlines + 2.
export const [liveCaretOffset, setLiveCaretOffset] = createSignal(0);
export const [sourceCaret, setSourceCaret] = createSignal({ line: 1, col: 1 });
const countNewlines = (s: string) => {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
};
export const caretLineCol = createMemo(() => {
  if (sourceMode()) return sourceCaret();
  const i = state.activeIndex;
  if (i < 0) return { line: 1, col: 1 };
  let line = 1;
  for (let k = 0; k < i; k++) line += countNewlines(state.blocks[k]?.text ?? "") + 2;
  const bt = state.blocks[i]?.text ?? "";
  const o = Math.min(liveCaretOffset(), bt.length);
  const before = bt.slice(0, o);
  line += countNewlines(before);
  const lastNl = before.lastIndexOf("\n");
  const col = (lastNl === -1 ? o : o - lastNl - 1) + 1;
  return { line, col };
});
export const fileName = createMemo(() =>
  state.filePath ? state.filePath.replace(/\\/g, "/").split("/").pop()! : "Untitled.md"
);

/* ---------- undo / redo ----------
   The live styler rebuilds innerHTML on every keystroke, which destroys the
   browser's native undo stack — so history lives here, at the document
   level. Snapshots capture blocks + activation + caret; consecutive typing
   into the same block coalesces into one entry. */

interface Snapshot {
  blocks: Block[];
  activeIndex: number;
  caret: number | null;
}

let undoStack: Snapshot[] = [];
let redoStack: Snapshot[] = [];
let lastPushKey: string | null = null;
let lastPushAt = 0;

// Injected by commands.ts (store can't import it — circular).
let caretProvider: (() => number | null) | null = null;
export function setCaretProvider(fn: () => number | null) {
  caretProvider = fn;
}

function snapshot(): Snapshot {
  return {
    blocks: state.blocks.map((b) => ({ ...b })),
    activeIndex: state.activeIndex,
    caret: caretProvider?.() ?? null,
  };
}

/**
 * Record the pre-mutation state. A `coalesceKey` (e.g. "type-3") merges
 * rapid consecutive pushes with the same key — keystrokes — into one entry.
 */
function pushHistory(coalesceKey: string | null = null) {
  const now = Date.now();
  redoStack.length = 0;
  // Inside an edit group the entry taken when it began covers everything.
  if (editGroup) return;
  if (coalesceKey !== null && coalesceKey === lastPushKey && now - lastPushAt < 800) {
    lastPushAt = now;
    return;
  }
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  lastPushKey = coalesceKey;
  lastPushAt = now;
}

let editGroup = false;

/**
 * Make everything until `endEditGroup()` one undo step, however long it takes
 * (voice typing streams words into a block over many seconds and pauses,
 * which the 800 ms keystroke coalescing would split up).
 */
export function beginEditGroup() {
  if (editGroup) return;
  pushHistory(null);
  editGroup = true;
}

export function endEditGroup() {
  editGroup = false;
  lastPushKey = null;
}

/** End a group whose changes were all reverted: drop its undo entry too. */
export function cancelEditGroup() {
  if (editGroup) undoStack.pop();
  endEditGroup();
}

function applySnapshot(s: Snapshot) {
  setState(
    produce((st) => {
      st.blocks = s.blocks.map((b) => ({ ...b }));
      st.activeIndex = Math.min(s.activeIndex, s.blocks.length - 1);
      st.dirty = true;
    })
  );
  if (s.caret != null) requestCaret(s.caret);
  lastPushKey = null; // the next edit starts a fresh history entry
  editGroup = false;
}

export function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(snapshot());
  applySnapshot(prev);
}

export function redo() {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snapshot());
  applySnapshot(next);
}

export interface DocMeta {
  encoding: string;
  hadBom: boolean;
}

export function loadDocument(text: string, path: string | null, meta?: DocMeta) {
  undoStack = [];
  redoStack = [];
  lastActive = -1;
  caretRequest = null;
  selectionRequest = null;
  setEncodingLossy(false);
  setExternalChange(null);
  setLiveCaretOffset(0);
  setSourceCaret({ line: 1, col: 1 });
  lastPushKey = null;
  setState(
    produce((s) => {
      s.blocks = splitBlocks(text).map(mkBlock);
      s.activeIndex = -1;
      s.filePath = path;
      s.dirty = false;
      s.encoding = meta?.encoding ?? "UTF-8";
      s.hadBom = meta?.hadBom ?? false;
    })
  );
}

/** Flip the dirty flag directly (autosave recovery marks a restored buffer
 *  dirty so the recovered-but-unsaved content can be written back). */
export function setDocDirty(v: boolean) {
  setState("dirty", v);
}

/** Update the encoding the document will be saved in (encoding picker). */
export function setEncoding(encoding: string, hadBom: boolean) {
  setState(produce((s) => {
    s.encoding = encoding;
    s.hadBom = hadBom;
  }));
}

let lastActive = -1;
export function setActive(index: number) {
  if (index >= 0) lastActive = index;
  setState("activeIndex", index);
}

/**
 * Block that paragraph/format commands should operate on: the active block,
 * else the block that last held the caret, else none (-1).
 */
export function targetBlockIndex(): number {
  if (state.activeIndex >= 0) return state.activeIndex;
  return lastActive >= 0 && lastActive < state.blocks.length ? lastActive : -1;
}

/** Point the document at a new path (rename/move) without touching dirty state. */
export function setFilePath(path: string) {
  setState("filePath", path);
  bumpRenderEpoch(); // doc dir changed → re-resolve relative image paths
}

export function markSaved(path: string) {
  const dirChanged = path !== state.filePath;
  setState(produce((s) => {
    s.filePath = path;
    s.dirty = false;
  }));
  if (dirChanged) bumpRenderEpoch();
}

/**
 * Update a block's text. If the text now contains a paragraph break
 * (blank line outside a code fence), split it into multiple blocks and
 * keep the caret in the last segment — this is what makes typing feel
 * continuous.
 */
export function updateBlock(index: number, text: string) {
  pushHistory(`type-${index}`);
  const parts = hasOpenFence(text) ? [text] : splitBlocks(text);
  setState(
    produce((s) => {
      if (parts.length <= 1) {
        s.blocks[index].text = text;
      } else {
        s.blocks.splice(index, 1, ...parts.map(mkBlock));
        s.activeIndex = index + parts.length - 1;
      }
      s.dirty = true;
    })
  );
}

let caretRequest: number | null = null;
export function requestCaret(pos: number) {
  caretRequest = pos;
}
export function consumeCaretRequest(): number | null {
  const c = caretRequest;
  caretRequest = null;
  return c;
}

// Like the caret request, but selects a range once the block is styled —
// used by find/replace to highlight the current match.
let selectionRequest: { start: number; end: number } | null = null;
export function requestSelection(start: number, end: number) {
  selectionRequest = { start, end };
}
export function consumeSelectionRequest(): { start: number; end: number } | null {
  const s = selectionRequest;
  selectionRequest = null;
  return s;
}

/** Move a block one position up or down, keeping activation glued to it. */
export function moveBlock(index: number, dir: -1 | 1) {
  const j = index + dir;
  if (index < 0 || index >= state.blocks.length || j < 0 || j >= state.blocks.length) return;
  pushHistory();
  setState(
    produce((s) => {
      const [b] = s.blocks.splice(index, 1);
      s.blocks.splice(j, 0, b);
      if (s.activeIndex === index) s.activeIndex = j;
      s.dirty = true;
    })
  );
}

export function mergeWithPrevious(index: number) {
  if (index <= 0) return;
  pushHistory();
  setState(
    produce((s) => {
      const prev = s.blocks[index - 1];
      requestCaret(prev.text.length + 1);
      prev.text = prev.text + "\n" + s.blocks[index].text;
      s.blocks.splice(index, 1);
      s.activeIndex = index - 1;
      s.dirty = true;
    })
  );
}

/** Finalize a block at the caret: `before` renders, `after` opens for editing. */
export function splitBlock(index: number, before: string, after: string) {
  pushHistory();
  setState(
    produce((s) => {
      s.blocks.splice(index, 1, mkBlock(before), mkBlock(after));
      s.activeIndex = index + 1;
      s.dirty = true;
    })
  );
  requestCaret(0);
}

export function insertBlockAfter(index: number, text = "") {
  pushHistory();
  setState(
    produce((s) => {
      s.blocks.splice(index + 1, 0, mkBlock(text));
      s.activeIndex = index + 1;
      s.dirty = true;
    })
  );
}

/** Append a block at the end without stealing activation (footnote defs). */
export function appendBlock(text: string) {
  pushHistory();
  setState(
    produce((s) => {
      s.blocks.push(mkBlock(text));
      s.dirty = true;
    })
  );
}

export function removeBlock(index: number) {
  pushHistory();
  setState(
    produce((s) => {
      s.blocks.splice(index, 1);
      if (s.blocks.length === 0) s.blocks.push(mkBlock(""));
      s.activeIndex = Math.min(index, s.blocks.length - 1);
      s.dirty = true;
    })
  );
}

/** Replace blocks[start..end] (inclusive) with a single block of `text` and
 *  activate it — used to delete/replace a selection that spans blocks. */
export function replaceBlocks(start: number, end: number, text: string) {
  const lo = Math.max(0, Math.min(start, end));
  const hi = Math.min(state.blocks.length - 1, Math.max(start, end));
  if (lo > hi) return;
  pushHistory();
  setState(
    produce((s) => {
      s.blocks.splice(lo, hi - lo + 1, mkBlock(text));
      if (s.blocks.length === 0) s.blocks.push(mkBlock(""));
      s.activeIndex = lo;
      s.dirty = true;
    })
  );
  requestCaret(text.length);
}

/** Replace `deleteCount` blocks at `start` with one block per entry of
 *  `texts` (an empty list deletes; deleteCount 0 inserts). Used to apply AI
 *  proposals, which are already split into blocks. */
export function spliceBlocks(start: number, deleteCount: number, texts: string[]): number[] {
  return spliceMany([{ start, deleteCount, texts }])[0];
}

/** Several splices as one store update and one undo step (Accept all). The
 *  ops apply in order, so callers pass them highest position first. Returns
 *  the ids of the blocks each op created. */
export function spliceMany(ops: { start: number; deleteCount: number; texts: string[] }[]): number[][] {
  pushHistory();
  const created: number[][] = [];
  setState(
    produce((s) => {
      for (const op of ops) {
        const blocks = op.texts.map(mkBlock);
        created.push(blocks.map((b) => b.id));
        s.blocks.splice(op.start, op.deleteCount, ...blocks);
      }
      if (s.blocks.length === 0) s.blocks.push(mkBlock(""));
      s.activeIndex = -1;
      s.dirty = true;
    })
  );
  return created;
}

/** Set heading level (0 = paragraph) on a block. */
export function setHeading(index: number, level: number) {
  pushHistory();
  setState(
    produce((s) => {
      const t = s.blocks[index].text.replace(/^#{1,6}\s+/, "");
      s.blocks[index].text = level === 0 ? t : "#".repeat(level) + " " + t;
      s.dirty = true;
    })
  );
}

/**
 * Blocks for `text`, reusing the id of each unchanged block. Source-mode edits
 * replace the whole document on every keystroke; keeping ids lets unchanged
 * blocks hit Block's render cache when Live mode returns.
 */
function reconcileBlocks(text: string): Block[] {
  const spare = new Map<string, number[]>();
  for (const b of state.blocks) {
    const ids = spare.get(b.text);
    if (ids) ids.push(b.id); else spare.set(b.text, [b.id]);
  }
  return splitBlocks(text).map((t) => {
    const id = spare.get(t)?.shift();
    return id === undefined ? mkBlock(t) : { id, text: t };
  });
}

export function replaceAll(text: string) {
  pushHistory();
  const blocks = reconcileBlocks(text);
  setState(
    produce((s) => {
      s.blocks = blocks;
      s.activeIndex = -1;
      s.dirty = true;
    })
  );
}

/* ---------- document tabs ----------
   The existing editor/command API continues to address `doc`. Inactive tabs
   retain their own buffer and history; switching restores them in one batch. */
type DocumentState = typeof state;
export interface TabView {
  scrollTop: number;
  sourceStart: number;
  sourceEnd: number;
}
const emptyView = (): TabView => ({ scrollTop: 0, sourceStart: 0, sourceEnd: 0 });
interface DocumentTab {
  id: number;
  document: DocumentState;
  undo: Snapshot[];
  redo: Snapshot[];
  caret: number | null;
  lastActive: number;
  sourceMode: boolean;
  lossy: boolean;
  conflict: ReturnType<typeof externalChange>;
  view: TabView;
}
let nextTabId = 1;
export const [activeTabId, setActiveTabId] = createSignal(nextTabId++);
let viewProvider: (() => TabView) | null = null;
export function setTabViewProvider(provider: (() => TabView) | null) { viewProvider = provider; }
const copyDocument = (): DocumentState => ({ ...state, blocks: state.blocks.map((b) => ({ ...b })) });
function captureTab(): DocumentTab {
  return {
    id: activeTabId(), document: copyDocument(), undo: undoStack, redo: redoStack,
    caret: caretProvider?.() ?? liveCaretOffset(), lastActive,
    sourceMode: sourceMode(), lossy: encodingLossy(), conflict: externalChange(),
    view: viewProvider?.() ?? emptyView(),
  };
}
const [tabRecords, setTabRecords] = createSignal<DocumentTab[]>([captureTab()]);
export const openTabs = createMemo(() => tabRecords().map((tab) => {
  const document = tab.id === activeTabId() ? state : tab.document;
  return { id: tab.id, filePath: document.filePath, dirty: document.dirty,
    name: document.filePath?.replace(/\\/g, "/").split("/").pop() || "Untitled.md" };
}));
export function openDocuments() {
  return tabRecords().map((tab) => ({ id: tab.id, document: tab.id === activeTabId() ? state : tab.document }));
}
export function getTabDocument(id: number): DocumentState | undefined {
  return id === activeTabId() ? copyDocument() : tabRecords().find((tab) => tab.id === id)?.document;
}
export function currentTabView(): TabView {
  return tabRecords().find((tab) => tab.id === activeTabId())?.view ?? emptyView();
}
function retainCurrentTab() {
  const current = captureTab();
  setTabRecords((tabs) => tabs.map((tab) => tab.id === current.id ? current : tab));
}
export function switchTab(id: number) {
  if (id === activeTabId()) return;
  const tab = tabRecords().find((entry) => entry.id === id);
  if (!tab) return;
  batch(() => {
    retainCurrentTab();
    undoStack = tab.undo;
    redoStack = tab.redo;
    lastPushKey = null;
    lastActive = tab.lastActive;
    caretRequest = tab.caret;
    selectionRequest = null;
    setState({ ...tab.document, blocks: tab.document.blocks.map((b) => ({ ...b })) });
    setSourceMode(tab.sourceMode);
    setEncodingLossy(tab.lossy);
    setExternalChange(tab.conflict);
    setLiveCaretOffset(tab.caret ?? 0);
    setSourceCaret({ line: 1, col: 1 });
    setActiveTabId(id);
  });
}
export function cycleTab(direction: -1 | 1) {
  const tabs = tabRecords();
  const index = tabs.findIndex((tab) => tab.id === activeTabId());
  switchTab(tabs[(index + direction + tabs.length) % tabs.length].id);
}

/** Reorder records without saving/restoring the active editor or its selection. */
export function moveTab(id: number, targetIndex: number) {
  if (!Number.isFinite(targetIndex)) return;
  setTabRecords((tabs) => {
    const from = tabs.findIndex((tab) => tab.id === id);
    const to = Math.max(0, Math.min(tabs.length - 1, Math.trunc(targetIndex)));
    if (from < 0 || from === to) return tabs;
    const reordered = [...tabs];
    const [tab] = reordered.splice(from, 1);
    reordered.splice(to, 0, tab);
    return reordered;
  });
}
export function findTabByPath(path: string): number | undefined {
  return openTabs().find((tab) => tab.filePath === path)?.id;
}
/** Open a new buffer; opening an existing file selects its unsaved buffer. */
export function openDocument(text: string, path: string | null, meta?: DocMeta): number {
  const existing = path ? findTabByPath(path) : undefined;
  if (existing !== undefined) { switchTab(existing); return existing; }
  // Reuse the initial empty scratch tab when a file is opened.
  const reuse = path && !state.filePath && !state.dirty && state.blocks.every((b) => !b.text);
  batch(() => {
    if (!reuse) {
      retainCurrentTab();
      setActiveTabId(nextTabId++);
      undoStack = [];
      redoStack = [];
    }
    loadDocument(text, path, meta);
    setSourceMode(false);
    const tab = captureTab();
    tab.view = emptyView();
    setTabRecords((tabs) => reuse ? tabs.map((entry) => entry.id === tab.id ? tab : entry) : [...tabs, tab]);
  });
  return activeTabId();
}
/** Called only after the command layer has handled unsaved changes. */
export function removeTab(id: number) {
  const tabs = tabRecords();
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return;
  batch(() => {
    if (id === activeTabId()) {
      if (tabs.length === 1) openDocument("", null);
      else switchTab(tabs[index + 1]?.id ?? tabs[index - 1].id);
    }
    setTabRecords((entries) => entries.filter((tab) => tab.id !== id));
  });
}
/** Save completion belongs to the tab that started it, even after a switch. */
export function markTabSaved(id: number, path: string, savedText: string) {
  const document = getTabDocument(id);
  if (!document) return;
  const dirty = joinBlocks(document.blocks.map((b) => b.text)) !== savedText;
  if (id === activeTabId()) {
    setState({ filePath: path, dirty });
    setExternalChange(null);
    bumpRenderEpoch();
  } else {
    setTabRecords((tabs) => tabs.map((tab) => tab.id === id
      ? { ...tab, document: { ...tab.document, filePath: path, dirty }, conflict: null } : tab));
  }
}
export function setTabExternalChange(path: string, deleted: boolean) {
  if (state.filePath === path) setExternalChange({ path, deleted });
  setTabRecords((tabs) => tabs.map((tab) => tab.id !== activeTabId() && tab.document.filePath === path
    ? { ...tab, conflict: { path, deleted } } : tab));
}
/** Reload a specific tab without replacing whichever document is now active. */
export function replaceTabDocument(id: number, text: string, path: string, meta: DocMeta, lossy = false) {
  if (id === activeTabId()) {
    loadDocument(text, path, meta);
    setEncodingLossy(lossy);
  } else {
    setTabRecords((tabs) => tabs.map((tab) => tab.id === id ? {
      ...tab, document: { blocks: splitBlocks(text).map(mkBlock), activeIndex: -1, filePath: path,
        dirty: false, encoding: meta.encoding, hadBom: meta.hadBom },
      undo: [], redo: [], caret: null, lastActive: -1, conflict: null, lossy, view: emptyView(),
    } : tab));
  }
}

/** Keep open buffers attached to file-tree renames, including inactive tabs. */
export function retargetTabPath(from: string, to: string | null) {
  batch(() => {
    if (state.filePath === from) {
      setState({ filePath: to, dirty: to === null || state.dirty });
      setExternalChange(null);
      bumpRenderEpoch();
    }
    setTabRecords((tabs) => tabs.map((tab) => tab.id !== activeTabId() && tab.document.filePath === from
      ? { ...tab, document: { ...tab.document, filePath: to, dirty: to === null || tab.document.dirty }, conflict: null } : tab));
  });
}
