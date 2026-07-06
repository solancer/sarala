import { createSignal, createMemo } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { FileNode } from "./platform";
import {
  splitBlocks,
  joinBlocks,
  hasOpenFence,
  extractOutline,
  countWords,
  setTocProvider,
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
] as const;
export type ThemeId = (typeof THEMES)[number];

export const [theme, setTheme] = createSignal<ThemeId>("sarala");
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
export const [mathFence, setMathFenceSig] = createSignal(false);

// Inline-syntax preferences (on by default; persisted).
export const [emojiEnabled, setEmojiEnabledSig] = createSignal(true);
export const [highlightEnabled, setHighlightEnabledSig] = createSignal(true);
export const [subSupEnabled, setSubSupEnabledSig] = createSignal(true);
export const [autolinkEnabled, setAutolinkEnabledSig] = createSignal(true);

// Bumped when a global render option changes so rendered blocks re-render.
export const [renderEpoch, setRenderEpoch] = createSignal(0);
export const bumpRenderEpoch = () => setRenderEpoch((n) => n + 1);

// Bumped when the theme changes so mermaid diagrams re-render in the new theme.
export const [mermaidEpoch, setMermaidEpoch] = createSignal(0);
export const bumpMermaidEpoch = () => setMermaidEpoch((n) => n + 1);

export const fullText = createMemo(() => joinBlocks(state.blocks.map((b) => b.text)));
export const outline = createMemo(() => extractOutline(state.blocks.map((b) => b.text)));
// eslint-disable-next-line solid/reactivity -- the provider runs inside Block's render (a tracked scope)
setTocProvider(() => outline());
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

const undoStack: Snapshot[] = [];
const redoStack: Snapshot[] = [];
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
  if (coalesceKey !== null && coalesceKey === lastPushKey && now - lastPushAt < 800) {
    lastPushAt = now;
    return;
  }
  undoStack.push(snapshot());
  if (undoStack.length > 200) undoStack.shift();
  lastPushKey = coalesceKey;
  lastPushAt = now;
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
  undoStack.length = 0;
  redoStack.length = 0;
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

export function replaceAll(text: string) {
  pushHistory();
  setState(
    produce((s) => {
      s.blocks = splitBlocks(text).map(mkBlock);
      s.activeIndex = -1;
      s.dirty = true;
    })
  );
}
