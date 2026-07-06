import { For, Show, createSignal, createEffect, onCleanup, onMount, type JSX } from "solid-js";
import type { FileNode } from "../platform";
import {
  outline, doc, folderPath, sidebarOpen, sidebarTab, setSidebarTab,
  sidebarWidth, setSidebarWidth, clampSidebar,
} from "../store";
import {
  setSetting, recentFiles, clearRecentFiles,
  pinnedFiles, isPinned, togglePin, clearPinned,
} from "../settings";
import { executeCommand } from "../commands";
import SearchPanel from "./SearchPanel";

interface Props {
  tree: FileNode[];
  folderName: string | null;
  onOpenFolder: () => void;
  onOpenFile: (path: string) => void;
  onJump: (blockIndex: number) => void;
}

/* ---------- icons ---------- */

const FileIcon = () => (
  <svg class="file-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"
      d="M4 1.6h5L12.4 5v9.4H4z M9 1.6V5h3.4" />
  </svg>
);
const TextFileIcon = () => (
  <svg class="file-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"
      d="M4 1.6h5L12.4 5v9.4H4z M9 1.6V5h3.4" />
    <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round"
      d="M5.7 8h4.6 M5.7 10.2h4.6 M5.7 12.4h2.8" />
  </svg>
);
const FolderIcon = () => (
  <svg class="folder-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round"
      d="M1.7 4c0-.5.4-.9.9-.9h2.7l1.2 1.3h6.9c.5 0 .9.4.9.9v6.7c0 .5-.4.9-.9.9H2.6c-.5 0-.9-.4-.9-.9z" />
  </svg>
);
const Chevron = (props: { open: boolean }) => (
  <svg class="tree-chevron" classList={{ open: props.open }} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);
// Tab icons.
const TabFilesIcon = () => (
  <svg class="side-tab-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
);
const TabOutlineIcon = () => (
  <svg class="side-tab-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <line x1="8" y1="7" x2="20" y2="7" /><line x1="8" y1="12" x2="20" y2="12" /><line x1="8" y1="17" x2="16" y2="17" />
    <circle cx="4" cy="7" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="17" r="1" />
  </svg>
);
const TabSearchIcon = () => (
  <svg class="side-tab-ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.5" y2="16.5" />
  </svg>
);

const PinIcon = () => (
  <svg class="pin-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" aria-hidden="true">
    <path d="M14 3l7 7-4 1-3 6-3-3-6 6 6-6-3-3 6-3 1-4z" />
  </svg>
);
const TrashIcon = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
    <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </svg>
);

const TEXT_EXT = /\.(md|markdown|mdx|txt|text|rst|adoc|org)$/i;
const FileGlyph = (props: { name: string }) => (
  <Show when={TEXT_EXT.test(props.name)} fallback={<FileIcon />}><TextFileIcon /></Show>
);

// Right-click Pin/Unpin menu (module-level so any file row can open it).
const [pinMenu, setPinMenu] = createSignal<{ x: number; y: number; path: string } | null>(null);
const openPinMenu = (e: MouseEvent, path: string) => {
  e.preventDefault();
  setPinMenu({ x: e.clientX, y: e.clientY, path });
};

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;

function countTree(nodes: FileNode[]): { files: number; folders: number } {
  let files = 0, folders = 0;
  for (const n of nodes) {
    if (n.is_dir) { folders++; const c = countTree(n.children ?? []); files += c.files; folders += c.folders; }
    else files++;
  }
  return { files, folders };
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
                role="treeitem"
                aria-selected={props.current === node.path}
                classList={{ current: props.current === node.path }}
                onClick={() => props.onOpenFile(node.path)}
                onContextMenu={(e) => openPinMenu(e, node.path)}
              >
                <FileGlyph name={node.name} />
                <span class="tree-nm">{node.name}</span>
                <Show when={isPinned(node.path)}>
                  <PinIcon />
                </Show>
                <Show when={props.current === node.path && doc.dirty}>
                  <span class="tree-dot" aria-label="Unsaved changes" />
                </Show>
              </button>
            }
          >
            <button
              class="tree-item dir"
              classList={{ open: open() }}
              role="treeitem"
              aria-expanded={open()}
              onClick={() => setOpen(!open())}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" && !open()) { e.preventDefault(); setOpen(true); }
                else if (e.key === "ArrowLeft" && open()) { e.preventDefault(); setOpen(false); }
              }}
            >
              <Chevron open={open()} />
              <FolderIcon />
              <span class="tree-nm">{node.name}</span>
            </button>
            <Show when={open()}>
              <div class="tree-children" role="group">
                <Tree nodes={node.children ?? []} depth={props.depth + 1} onOpenFile={props.onOpenFile} current={props.current} />
              </div>
            </Show>
          </Show>
        );
      }}
    </For>
  );
}

export default function Sidebar(props: Props) {
  const [activeHeading, setActiveHeading] = createSignal(-1);
  const headings = () => outline();
  const counts = () => countTree(props.tree);
  const badge = () => (props.folderName ?? "Sarala").trim().charAt(0).toUpperCase() || "S";

  /* --- width resize --- */
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

  /* --- outline scroll-spy (active heading in the editor viewport) --- */
  onMount(() => {
    const scroller = document.querySelector<HTMLElement>(".scroll");
    if (!scroller) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const hs = headings();
      if (!hs.length) { setActiveHeading(-1); return; }
      const blocks = scroller.querySelectorAll<HTMLElement>(".block");
      const top = scroller.getBoundingClientRect().top;
      let active = 0;
      for (let i = 0; i < hs.length; i++) {
        const b = blocks[hs[i].blockIndex];
        if (!b) continue;
        if (b.getBoundingClientRect().top - top <= 110) active = i;
        else break;
      }
      setActiveHeading(active);
    };
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(compute); };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    createEffect(() => { void headings(); void doc.activeIndex; requestAnimationFrame(compute); });
    onCleanup(() => { scroller.removeEventListener("scroll", onScroll); if (raf) cancelAnimationFrame(raf); });
  });

  // Dismiss the pin menu on outside click / Escape.
  onMount(() => {
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement).closest(".ctx-menu")) setPinMenu(null); };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setPinMenu(null);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onEsc);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onEsc);
    });
  });

  const onNav = (e: KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="treeitem"]')]
      .filter((el) => el.offsetParent !== null);
    if (!items.length) return;
    const i = items.indexOf(document.activeElement as HTMLElement);
    e.preventDefault();
    const next = e.key === "ArrowDown" ? Math.min(i + 1, items.length - 1)
      : e.key === "ArrowUp" ? Math.max(i - 1, 0)
      : e.key === "Home" ? 0 : items.length - 1;
    items[next]?.focus();
  };

  const Tab = (p: { id: "files" | "outline" | "search"; icon: () => JSX.Element; label: string }) => (
    <button
      class="side-tab"
      role="tab"
      aria-selected={sidebarTab() === p.id}
      classList={{ on: sidebarTab() === p.id }}
      onClick={() => setSidebarTab(p.id)}
    >
      {p.icon()}
      <span>{p.label}</span>
    </button>
  );

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

      {/* ===== workspace header ===== */}
      <div class="side-ws-head">
        <span class="side-ws-badge" aria-hidden="true">{badge()}</span>
        <span class="side-ws-name">{props.folderName ?? "Sarala"}</span>
        <button class="side-icon-btn" title="New file" aria-label="New file" onClick={() => executeCommand("file.new")}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>

      {/* ===== segmented tabs ===== */}
      <div class="side-tabs" role="tablist">
        <Tab id="files" icon={() => <TabFilesIcon />} label="Files" />
        <Tab id="outline" icon={() => <TabOutlineIcon />} label="Outline" />
        <Tab id="search" icon={() => <TabSearchIcon />} label="Search" />
      </div>

      {/* ===== tab body ===== */}
      <div class="side-tab-body scrollarea">
        {/* --- Files --- */}
        <Show when={sidebarTab() === "files"}>
          <Show when={pinnedFiles().length}>
            <div class="side-list-head side-list-head-row">
              <span>Pinned</span>
              <button class="side-clear-btn" title="Clear pinned files" onClick={() => void clearPinned()}>
                <TrashIcon /> Clear
              </button>
            </div>
            <div class="side-recent" role="list">
              <For each={pinnedFiles()}>
                {(path) => (
                  <button
                    class="tree-item file pinned"
                    role="treeitem"
                    classList={{ current: doc.filePath === path }}
                    onClick={() => props.onOpenFile(path)}
                    onContextMenu={(e) => openPinMenu(e, path)}
                  >
                    <PinIcon />
                    <span class="tree-nm">{baseName(path)}</span>
                  </button>
                )}
              </For>
            </div>
            <div class="side-divider" />
          </Show>

          <Show when={recentFiles().length}>
            <div class="side-list-head side-list-head-row">
              <span>Recent</span>
              <button class="side-clear-btn" title="Clear recent files" onClick={() => void clearRecentFiles()}>
                <TrashIcon /> Clear
              </button>
            </div>
            <div class="side-recent" role="list">
              <For each={recentFiles().slice(0, 6)}>
                {(path) => (
                  <button
                    class="tree-item file"
                    role="treeitem"
                    classList={{ current: doc.filePath === path }}
                    onClick={() => props.onOpenFile(path)}
                    onContextMenu={(e) => openPinMenu(e, path)}
                  >
                    <FileGlyph name={baseName(path)} />
                    <span class="tree-nm">{baseName(path)}</span>
                    <Show when={isPinned(path)}><PinIcon /></Show>
                  </button>
                )}
              </For>
            </div>
            <div class="side-divider" />
          </Show>

          <div class="side-list-head">All files</div>
          <div class="side-tree" role="tree" aria-label="Files" onKeyDown={onNav}>
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
          </div>
        </Show>

        {/* --- Outline --- */}
        <Show when={sidebarTab() === "outline"}>
          <div class="side-tree" role="tree" aria-label="Outline" onKeyDown={onNav}>
            <Show when={headings().length} fallback={<div class="sidebar-empty"><p>No headings yet.</p></div>}>
              <For each={headings()}>
                {(h, i) => (
                  <button
                    class="side-out-item"
                    role="treeitem"
                    classList={{ active: i() === activeHeading(), h1: h.level === 1 }}
                    aria-current={i() === activeHeading() ? "true" : undefined}
                    style={{ "padding-left": `${10 + (h.level - 1) * 13}px` }}
                    onClick={() => props.onJump(h.blockIndex)}
                  >
                    <span class="tree-nm">{h.text}</span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </Show>

        {/* --- Search --- */}
        <Show when={sidebarTab() === "search"}>
          <Show when={folderPath()} fallback={<div class="sidebar-empty"><p>Open a folder to search across files.</p></div>}>
            <SearchPanel onOpenFile={props.onOpenFile} />
          </Show>
        </Show>
      </div>

      {/* ===== pin/unpin context menu ===== */}
      <Show when={pinMenu()}>
        {(m) => (
          <div class="ctx-menu" style={{ left: `${m().x}px`, top: `${m().y}px` }} onContextMenu={(e) => e.preventDefault()}>
            <button
              class="ctx-item"
              onMouseDown={(e) => { e.preventDefault(); void togglePin(m().path); setPinMenu(null); }}
            >
              <PinIcon />
              <span class="ctx-label">{isPinned(m().path) ? "Unpin" : "Pin to top"}</span>
            </button>
          </div>
        )}
      </Show>

      {/* ===== footer ===== */}
      <Show when={props.tree.length > 0}>
        <div class="side-foot">
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          </svg>
          <span>{counts().files} files · {counts().folders} folders</span>
        </div>
      </Show>
    </aside>
  );
}
