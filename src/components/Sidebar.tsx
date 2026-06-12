import { For, Show, createSignal } from "solid-js";
import type { FileNode } from "../platform";
import { outline, doc, sidebarTab, setSidebarTab } from "../store";

interface Props {
  tree: FileNode[];
  folderName: string | null;
  onOpenFolder: () => void;
  onOpenFile: (path: string) => void;
  onJump: (blockIndex: number) => void;
}

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
                {node.name}
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
  // Lifted to the store so View > File Tree / Outline can switch it.
  const tab = sidebarTab;
  const setTab = setSidebarTab;
  return (
    <aside class="sidebar">
      <div class="sidebar-tabs" role="tablist">
        <button role="tab" classList={{ on: tab() === "files" }} onClick={() => setTab("files")}>Files</button>
        <button role="tab" classList={{ on: tab() === "outline" }} onClick={() => setTab("outline")}>Outline</button>
      </div>

      <Show when={tab() === "files"}>
        <div class="sidebar-body">
          <Show
            when={props.tree.length > 0}
            fallback={
              <div class="sidebar-empty">
                <p>No folder open.</p>
                <button class="ghost-btn" onClick={props.onOpenFolder}>Open folder…</button>
              </div>
            }
          >
            <div class="folder-name">{props.folderName}</div>
            <Tree nodes={props.tree} depth={0} onOpenFile={props.onOpenFile} current={doc.filePath} />
          </Show>
        </div>
      </Show>

      <Show when={tab() === "outline"}>
        <div class="sidebar-body">
          <Show when={outline().length > 0} fallback={<div class="sidebar-empty"><p>No headings yet.</p></div>}>
            <For each={outline()}>
              {(h) => (
                <button
                  class="tree-item heading"
                  style={{ "padding-left": `${10 + (h.level - 1) * 14}px` }}
                  onClick={() => props.onJump(h.blockIndex)}
                >
                  {h.text}
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </aside>
  );
}
