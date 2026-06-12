import { createSignal, createMemo } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { FileNode } from "./platform";
import {
  splitBlocks,
  joinBlocks,
  hasOpenFence,
  extractOutline,
  countWords,
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

export const THEMES = ["paper", "graphite"] as const;
export type ThemeId = (typeof THEMES)[number];

export const [theme, setTheme] = createSignal<ThemeId>("paper");
export const [sourceMode, setSourceMode] = createSignal(false);
export const [sidebarOpen, setSidebarOpen] = createSignal(true);

// Workspace folder shown in the sidebar (lifted out of App so the command
// bus can drive "Open Folder…").
export const [fileTree, setFileTree] = createSignal<FileNode[]>([]);
export const [folderName, setFolderName] = createSignal<string | null>(null);

export const fullText = createMemo(() => joinBlocks(state.blocks.map((b) => b.text)));
export const outline = createMemo(() => extractOutline(state.blocks.map((b) => b.text)));
export const stats = createMemo(() => countWords(fullText()));
export const fileName = createMemo(() =>
  state.filePath ? state.filePath.replace(/\\/g, "/").split("/").pop()! : "Untitled.md"
);

export function loadDocument(text: string, path: string | null) {
  setState(
    produce((s) => {
      s.blocks = splitBlocks(text).map(mkBlock);
      s.activeIndex = -1;
      s.filePath = path;
      s.dirty = false;
    })
  );
}

export function setActive(index: number) {
  setState("activeIndex", index);
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

export function mergeWithPrevious(index: number) {
  if (index <= 0) return;
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
  setState(
    produce((s) => {
      s.blocks.splice(index + 1, 0, mkBlock(text));
      s.activeIndex = index + 1;
      s.dirty = true;
    })
  );
}

export function removeBlock(index: number) {
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
  setState(
    produce((s) => {
      const t = s.blocks[index].text.replace(/^#{1,6}\s+/, "");
      s.blocks[index].text = level === 0 ? t : "#".repeat(level) + " " + t;
      s.dirty = true;
    })
  );
}

export function replaceAll(text: string) {
  setState(
    produce((s) => {
      s.blocks = splitBlocks(text).map(mkBlock);
      s.activeIndex = -1;
      s.dirty = true;
    })
  );
}
