import { For, Show, createSignal } from "solid-js";
import type { FileNode } from "../platform";
import {
  outline, doc, folderPath, sidebarOpen,
  sidebarWidth, setSidebarWidth, clampSidebar,
} from "../store";
import { setSetting } from "../settings";
import SearchPanel from "./SearchPanel";

interface Props {
  tree: FileNode[];
  folderName: string | null;
  onOpenFolder: () => void;
  onOpenFile: (path: string) => void;
  onJump: (blockIndex: number) => void;
}

// Plain document outline (default file glyph).
const FileIcon = () => (
  <svg class="file-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"
      d="M4 1.6h5L12.4 5v9.4H4z M9 1.6V5h3.4" />
  </svg>
);

// Document with text lines — used for Markdown / plain-text files.
const TextFileIcon = () => (
  <svg class="file-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"
      d="M4 1.6h5L12.4 5v9.4H4z M9 1.6V5h3.4" />
    <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"
      d="M5.7 8h4.6 M5.7 10.2h4.6 M5.7 12.4h2.8" />
  </svg>
);

// Outline folder, consistent for every directory (the chevron shows open/closed).
const FolderIcon = () => (
  <svg class="folder-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"
      d="M1.7 4c0-.5.4-.9.9-.9h2.7l1.2 1.3h6.9c.5 0 .9.4.9.9v6.7c0 .5-.4.9-.9.9H2.6c-.5 0-.9-.4-.9-.9z" />
  </svg>
);

// Disclosure chevron for expandable rows — rotates 90° when open.
const Chevron = (props: { open: boolean }) => (
  <svg
    class="tree-chevron"
    classList={{ open: props.open }}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2.4"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="m9 6 6 6-6 6" />
  </svg>
);

const TEXT_EXT = /\.(md|markdown|mdx|txt|text|rst|adoc|org)$/i;

/** Leading file glyph: a lined-document for text/Markdown, else a plain document. */
const FileGlyph = (props: { name: string }) =>
  TEXT_EXT.test(props.name) ? <TextFileIcon /> : <FileIcon />;

function Tree(props: { nodes: FileNode[]; depth: number; onOpenFile: (p: string) => void; current: string | null }) {
  return (
    <For each={props.nodes}>
      {(node) => {
        const [open, setOpen] = createSignal(props.depth < 1);
        return (
          <Show
            when={node.is_dir}
            fallback={
              <button
                class="tree-item file"
                classList={{ current: props.current === node.path }}
                style={{ "padding-left": `${10 + props.depth * 14}px` }}
                onClick={() => props.onOpenFile(node.path)}
              >
                <FileGlyph name={node.name} /> {node.name}
              </button>
            }
          >
            <button
              class="tree-item dir"
              style={{ "padding-left": `${10 + props.depth * 14}px` }}
              onClick={() => setOpen(!open())}
            >
              <Chevron open={open()} />
              <FolderIcon /> {node.name}
            </button>
            <Show when={open()}>
              <Tree nodes={node.children ?? []} depth={props.depth + 1} onOpenFile={props.onOpenFile} current={props.current} />
            </Show>
          </Show>
        );
      }}
    </For>
  );
}

export default function Sidebar(props: Props) {
  const [searchOpen, setSearchOpen] = createSignal(false);
  // Drag-to-resize. The sidebar hugs the left edge, so the
  // pointer's clientX is the width directly; persist on release.
  const startResize = (e: PointerEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const onMove = (m: PointerEvent) => setSidebarWidth(clampSidebar(m.clientX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      void setSetting("sidebarWidth", sidebarWidth());
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  return (
    <aside
      class="sidebar"
      classList={{ collapsed: !sidebarOpen() }}
      aria-hidden={!sidebarOpen()}
      style={{
        width: `${sidebarWidth()}px`,
        "margin-left": sidebarOpen() ? "0px" : `-${sidebarWidth()}px`,
      }}
    >
      <div class="sidebar-resize" title="Drag to resize" onPointerDown={startResize} />

      <div class="sidebar-body">
        <Show when={folderPath()}>
          <button class="side-section-head toggle" onClick={() => setSearchOpen(!searchOpen())}>
            <Chevron open={searchOpen()} /> Search
          </button>
          <Show when={searchOpen()}>
            <SearchPanel onOpenFile={props.onOpenFile} />
          </Show>
        </Show>

        <div class="side-section-head">Files</div>
        <Show
          when={props.tree.length > 0}
          fallback={
            <div class="sidebar-empty">
              <p>No folder open.</p>
              <button class="ghost-btn" onClick={props.onOpenFolder}>Open folder…</button>
            </div>
          }
        >
          <Tree nodes={props.tree} depth={0} onOpenFile={props.onOpenFile} current={doc.filePath} />
        </Show>

        <div class="side-section-head">Outline</div>
        <Show when={outline().length > 0} fallback={<div class="side-outline-empty">No headings yet.</div>}>
          <For each={outline()}>
            {(h) => (
              <button
                class="tree-item heading"
                classList={{ h1: h.level === 1 }}
                style={{ "padding-left": `${10 + (h.level - 1) * 14}px` }}
                onClick={() => props.onJump(h.blockIndex)}
              >
                <span class="out-mark">{"›"}</span> {h.text}
              </button>
            )}
          </For>
        </Show>
      </div>
    </aside>
  );
}
