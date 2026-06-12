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

const WELCOME = `# Welcome to Inkdown

A seamless **WYSIWYG Markdown** editor built with *Tauri* and *SolidJS* — no preview pane, no split view. Click any block to edit its Markdown source; click away and it renders in place.

## Why no preview window?

> A Markdown document should be publishable as-is, as plain text, without looking like it's been marked up with tags or formatting instructions.

Split panes duplicate content, waste half the screen, and pull your eyes away from the writing. Here, the editing surface *is* the preview.

## What works

- **Live blocks** — click to reveal source, blur to render
- Keyboard: \`Cmd/Ctrl+B\` bold, \`I\` italic, \`K\` link, \`1–6\` headings
- Task lists with clickable checkboxes
- [ ] try checking this
- [x] this one is done

### Code, highlighted the same on screen and in export

\`\`\`rust
#[tauri::command]
fn save_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
}
\`\`\`

### Tables

| Shortcut | Action |
| --- | --- |
| Cmd/Ctrl+S | Save |
| Cmd/Ctrl+/ | Source mode |
| Cmd/Ctrl+\\\\ | Toggle sidebar |

Open a folder from the sidebar to browse your notes, or just start typing.
`;

const [state, setState] = createStore({
  blocks: splitBlocks(WELCOME).map(mkBlock) as Block[],
  activeIndex: -1 as number,
  filePath: null as string | null,
  dirty: false,
});

// eslint-disable-next-line solid/reactivity -- store proxy re-export; consumers read it in tracked scopes
export const doc = state;

export const THEMES = ["paper", "graphite", "github", "night", "newsprint", "whitey"] as const;
export type ThemeId = (typeof THEMES)[number];

export const [theme, setTheme] = createSignal<ThemeId>("github");
export const [sourceMode, setSourceMode] = createSignal(false);
export const [sidebarOpen, setSidebarOpen] = createSignal(true);
export const [sidebarTab, setSidebarTab] = createSignal<"files" | "outline">("files");
export const [focusMode, setFocusMode] = createSignal(false);
export const [typewriterMode, setTypewriterMode] = createSignal(false);
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

// Edit-menu toggles (persisted in settings).
export const [spellcheckOn, setSpellcheckOn] = createSignal(true);
export const [smartPunctuation, setSmartPunctuation] = createSignal(false);
export const [preserveBreaks, setPreserveBreaks] = createSignal(false);
export const [lineEnding, setLineEnding] = createSignal<"lf" | "crlf">("lf");

// Format ▸ Image: copy inserted local images into ./assets next to the doc.
export const [copyImageToAssets, setCopyImageToAssets] = createSignal(false);

// Tables stretch to the page column instead of sizing to their content.
export const [tableFullWidth, setTableFullWidth] = createSignal(false);

// Bumped when a global render option changes so rendered blocks re-render.
export const [renderEpoch, setRenderEpoch] = createSignal(0);
export const bumpRenderEpoch = () => setRenderEpoch((n) => n + 1);

export const fullText = createMemo(() => joinBlocks(state.blocks.map((b) => b.text)));
export const outline = createMemo(() => extractOutline(state.blocks.map((b) => b.text)));
// eslint-disable-next-line solid/reactivity -- the provider runs inside Block's render (a tracked scope)
setTocProvider(() => outline());
export const stats = createMemo(() => countWords(fullText()));
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

export function loadDocument(text: string, path: string | null) {
  undoStack.length = 0;
  redoStack.length = 0;
  lastPushKey = null;
  setState(
    produce((s) => {
      s.blocks = splitBlocks(text).map(mkBlock);
      s.activeIndex = -1;
      s.filePath = path;
      s.dirty = false;
    })
  );
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
}

export function markSaved(path: string) {
  setState(produce((s) => {
    s.filePath = path;
    s.dirty = false;
  }));
}

/**
 * Update a block's text. If the text now contains a paragraph break
 * (blank line outside a code fence), split it into multiple blocks and
 * keep the caret in the last segment — this is what makes typing feel
 * continuous, like Typora.
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
