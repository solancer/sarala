import { For, Show, createSignal } from "solid-js";
import type { FileNode } from "../platform";
import {
  outline, doc, folderPath,
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

const FileIcon = () => (
  <svg class="file-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.1"
      d="M4 1.6h5L12.4 5v9.4H4z M9 1.6V5h3.4" />
  </svg>
);

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
                <FileIcon /> {node.name}
              </button>
            }
          >
            <button
              class="tree-item dir"
              style={{ "padding-left": `${10 + props.depth * 14}px` }}
              onClick={() => setOpen(!open())}
            >
              <span class="twist">{open() ? "▾" : "▸"}</span> {node.name}
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
    <aside class="sidebar" style={{ width: `${sidebarWidth()}px` }}>
      <div class="sidebar-resize" title="Drag to resize" onPointerDown={startResize} />

      <div class="sidebar-body">
        <Show when={folderPath()}>
          <button class="side-section-head toggle" onClick={() => setSearchOpen(!searchOpen())}>
            <span class="twist">{searchOpen() ? "▾" : "▸"}</span> Search
          </button>
          <Show when={searchOpen()}>
            <SearchPanel onOpenFile={props.onOpenFile} />
          </Show>
        </Show>

        <div class="side-section-head">Workspace</div>
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
