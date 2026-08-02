import { For, Show, createSignal, createEffect, createMemo, on, onCleanup, onMount, type JSX } from "solid-js";
import { isMac, isTauri, type FileNode } from "../platform";
import {
  outline, doc, folderPath, sidebarOpen, sidebarTab, setSidebarTab,
  sidebarWidth, setSidebarWidth, clampSidebar,
  isFolderOpen, toggleFolder, openAncestors, collapseAllFolders, openFolders,
  isMissing,
} from "../store";
import {
  setSetting, getSetting, recentFiles, clearRecentFiles, removeRecentFile, saveOpenFolders,
  pinnedFiles, isPinned, togglePin, clearPinned,
} from "../settings";
import {
  executeCommand, renamePath, deletePath, revealPath, copyPath, newFileNear,
  validateRecentPaths,
} from "../commands";
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
  <svg class="side-tab-ic" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M21 6h-9M21 12h-7M21 18h-9M3 5v5a2 2 0 0 0 2 2h3M3 10v6a2 2 0 0 0 2 2h5" />
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
const MissingIcon = () => (
  <svg class="missing-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
    stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
    <circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" />
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

// Right-click file menu (module-level so any row can open it).
const [pinMenu, setPinMenu] = createSignal<
  { x: number; y: number; path: string; isDir: boolean; recent: boolean } | null
>(null);
const openPinMenu = (e: MouseEvent, path: string, isDir = false, recent = false) => {
  e.preventDefault();
  e.stopPropagation();
  setPinMenu({ x: e.clientX, y: e.clientY, path, isDir, recent });
};

const baseName = (p: string) => p.replace(/\\/g, "/").split("/").pop() ?? p;
/** Containing folder, shown beside the name so duplicate basenames differ. */
const parentName = (p: string) => {
  const segs = p.replace(/\\/g, "/").split("/");
  return segs.length > 1 ? segs[segs.length - 2] : "";
};

function countTree(nodes: FileNode[]): { files: number; folders: number } {
  let files = 0, folders = 0;
  for (const n of nodes) {
    if (n.is_dir) { folders++; const c = countTree(n.children ?? []); files += c.files; folders += c.folders; }
    else files++;
  }
  return { files, folders };
}

/**
 * One rendered line of the tree. The tree is flattened to this list rather than
 * rendered recursively: a flat array is what makes filtering, scroll-to-row,
 * ARIA position indices, and windowing all straightforward — each of which was
 * awkward or impossible against nested components.
 */
interface Row {
  node: FileNode;
  depth: number;
  /** 1-based index among siblings, and sibling count — for ARIA. */
  pos: number;
  size: number;
}

/** Case-insensitive subsequence-free substring match, used by the filter. */
const hit = (name: string, q: string) => name.toLowerCase().includes(q);

/**
 * Walk the tree into visible rows. A folder contributes its children only when
 * expanded — except while filtering, when any folder containing a match is
 * forced open so results are reachable without hunting.
 */
function flatten(nodes: FileNode[], query: string, depth = 0, out: Row[] = []): Row[] {
  const q = query.trim().toLowerCase();
  nodes.forEach((node, i) => {
    const row: Row = { node, depth, pos: i + 1, size: nodes.length };
    if (!node.is_dir) {
      if (!q || hit(node.name, q)) out.push(row);
      return;
    }
    const kids = node.children ?? [];
    if (q) {
      // Probe the subtree first: a folder with no matching descendant and no
      // matching name of its own is omitted entirely rather than shown empty.
      const sub = flatten(kids, query, depth + 1);
      if (sub.length || hit(node.name, q)) {
        out.push(row);
        out.push(...sub);
      }
      return;
    }
    out.push(row);
    if (isFolderOpen(node.path)) flatten(kids, query, depth + 1, out);
  });
  return out;
}

/** Row height in px — must match `.tree-item` in app.css for windowing to line up. */
const ROW_H = 28;
/** Below this many rows, render everything (short trees keep native behaviour). */
const WINDOW_MIN = 300;
/** Extra rows above/below the viewport, so fast scrolling doesn't show gaps. */
const OVERSCAN = 12;

export default function Sidebar(props: Props) {
  const [activeHeading, setActiveHeading] = createSignal(-1);
  const [filter, setFilter] = createSignal("");
  const [recentOpen, setRecentOpen] = createSignal(getSetting("recentOpen", true));
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);
  let filterEl: HTMLInputElement | undefined;
  let treeEl: HTMLDivElement | undefined;

  // Flattened visible rows. Depends on openFolders() so expanding re-runs it.
  const rows = createMemo(() => {
    void openFolders();
    return flatten(props.tree, filter());
  });

  const windowed = createMemo(() => rows().length > WINDOW_MIN);
  const firstIdx = createMemo(() =>
    windowed() ? Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN) : 0,
  );
  const lastIdx = createMemo(() =>
    windowed()
      ? Math.min(rows().length, Math.ceil((scrollTop() + viewH()) / ROW_H) + OVERSCAN)
      : rows().length,
  );
  const visibleRows = createMemo(() => rows().slice(firstIdx(), lastIdx()));
  const padTop = () => firstIdx() * ROW_H;
  const padBottom = () => Math.max(0, (rows().length - lastIdx()) * ROW_H);
  const headings = () => outline();
  /**
   * Shallowest heading level in the document. Indent and emphasis are measured
   * from this rather than from `#`, so a README whose top level is `##` still
   * gets a flush, ink-coloured first tier instead of rendering as one
   * uniformly indented block of grey.
   */
  const baseLevel = () => headings().reduce((m, h) => Math.min(m, h.level), 6);
  const counts = () => countTree(props.tree);

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

  /* --- flag Recent/Pinned entries whose file is gone --- */
  createEffect(() => {
    void recentFiles();
    void pinnedFiles();
    void doc.filePath; // a save/rename can resurrect or orphan a path
    void validateRecentPaths();
  });

  /* --- windowing: track the scroll container the tree lives in --- */
  onMount(() => {
    const scroller = treeEl?.closest<HTMLElement>(".side-tab-body");
    if (!scroller) return;
    const onScroll = () => setScrollTop(scroller.scrollTop);
    const ro = new ResizeObserver(() => setViewH(scroller.clientHeight || 600));
    ro.observe(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    setViewH(scroller.clientHeight || 600);
    onCleanup(() => {
      scroller.removeEventListener("scroll", onScroll);
      ro.disconnect();
    });
  });

  /* --- reveal the active file: expand its ancestors, then scroll to it ---
     Runs whenever the open document changes (Quick Open, Recent, the menu), so
     the tree never silently disagrees with what is in the editor. */
  createEffect(
    on(
      () => doc.filePath,
      (path) => {
        if (!path || sidebarTab() !== "files") return;
        openAncestors(path, folderPath());
        void saveOpenFolders();
        // Wait for the expansion to render before measuring the row.
        requestAnimationFrame(() => {
          const idx = rows().findIndex((r) => r.node.path === path);
          if (idx < 0) return;
          const scroller = treeEl?.closest<HTMLElement>(".side-tab-body");
          const row = treeEl?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
          if (row) row.scrollIntoView({ block: "nearest" });
          // A windowed row may not be rendered yet; drive the scroller directly.
          else if (scroller) scroller.scrollTop = Math.max(0, idx * ROW_H - scroller.clientHeight / 2);
        });
      },
      { defer: true },
    ),
  );

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

  /**
   * Tree keyboard model: arrows move focus, Left/Right collapse/expand a folder,
   * and a printable character jumps to the next row starting with it (the
   * typeahead the ARIA tree pattern expects).
   */
  let typeahead = "";
  let typeaheadAt = 0;
  const onTreeKey = (e: KeyboardEvent) => {
    const el = e.currentTarget as HTMLElement;
    const items = [...el.querySelectorAll<HTMLElement>('[role="treeitem"]')];
    const focused = document.activeElement as HTMLElement;
    const i = items.indexOf(focused);

    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      const path = focused?.dataset.path;
      if (!path || focused.getAttribute("aria-expanded") === null) return;
      const open = focused.getAttribute("aria-expanded") === "true";
      if (e.key === "ArrowRight" && !open) { e.preventDefault(); toggleFolder(path); void saveOpenFolders(); }
      if (e.key === "ArrowLeft" && open) { e.preventDefault(); toggleFolder(path); void saveOpenFolders(); }
      return;
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typeahead = now - typeaheadAt > 700 ? e.key : typeahead + e.key;
      typeaheadAt = now;
      const q = typeahead.toLowerCase();
      const from = i >= 0 ? i : 0;
      const order = [...items.slice(from + 1), ...items.slice(0, from + 1)];
      const found = order.find((it) =>
        (it.querySelector(".tree-nm")?.textContent ?? "").toLowerCase().startsWith(q),
      );
      if (found) { e.preventDefault(); found.focus(); found.scrollIntoView({ block: "nearest" }); }
      return;
    }
    onNav(e);
  };

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
      title={p.label}
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

      {/* macOS overlay title bar: the traffic lights float above this band. It
          used to be plain padding on .sidebar, which meant the strip beside the
          lights was dead space — the one part of the window top that would not
          drag. A real element can carry the drag region; the gap child opts
          itself out (`="false"`), because a drag region *under* the native
          lights swallows their clicks. */}
      <Show when={isTauri && isMac}>
        <div class="side-traffic" data-tauri-drag-region="deep">
          <span class="side-traffic-gap" data-tauri-drag-region="false" aria-hidden="true" />
        </div>
      </Show>

      {/* ===== workspace header ===== */}
      {/* Drag region, matching the content pane's floating strip — the whole
          top band of the window moves the window. "deep" so the workspace name
          and the empty space beside it drag too; Tauri's script still exempts
          the New-file button, which is a real control. On macOS the sidebar is
          padded down past the traffic lights, which must stay outside any drag
          region or they stop receiving their own clicks. */}
      <div class="side-ws-head" data-tauri-drag-region="deep">
        {/* A folder glyph, not an initial: the old badge restated the first
            letter of the word beside it, carried no information, and was the
            loudest element in the panel. The glyph instead says *what* the name
            is — a folder — which is the thing that was ambiguous. */}
        <svg
          class="side-ws-glyph"
          viewBox="0 0 24 24" width="15" height="15"
          fill="none" stroke="currentColor" stroke-width="1.7"
          stroke-linejoin="round" aria-hidden="true"
        >
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
        <span
          class="side-ws-name"
          classList={{ empty: !props.folderName }}
          title={props.tree.length
            ? `${folderPath() ?? ""}\n${counts().files} files · ${counts().folders} folders`
            : undefined}
        >
          {/* Falling back to the app name read as branding and hid the fact
              that nothing is open. Name the actual state instead. */}
          {props.folderName ?? "No folder open"}
        </span>
        <button
          class="side-icon-btn"
          title={props.folderName ? "Open a different folder…" : "Open folder…"}
          aria-label="Open folder"
          onClick={() => props.onOpenFolder()}
        >
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h5a2 2 0 0 1 2 2v1" />
            <path d="M3 9h17.5a1 1 0 0 1 .95 1.3l-2.1 7A2 2 0 0 1 17.4 19H4.5a2 2 0 0 1-2-2z" />
          </svg>
        </button>
        <button class="side-icon-btn" title="New file" aria-label="New file" onClick={() => executeCommand("file.new")}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      {/* ===== segmented tabs ===== */}
      <div class="side-tabs" role="tablist">
        <Tab id="files" icon={() => <TabFilesIcon />} label="Files" />
        <Tab id="outline" icon={() => <TabOutlineIcon />} label="Outline" />
        <Tab id="search" icon={() => <TabSearchIcon />} label="Find" />
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
                    classList={{ current: doc.filePath === path, missing: isMissing(path) }}
                    onClick={() => props.onOpenFile(path)}
                    onContextMenu={(e) => openPinMenu(e, path)}
                    title={isMissing(path) ? `Missing — ${path}` : path}
                  >
                    <Show when={isMissing(path)} fallback={<PinIcon />}><MissingIcon /></Show>
                    <span class="tree-nm">{baseName(path)}</span>
                    <Show when={parentName(path)}>
                      <span class="tree-parent">{parentName(path)}</span>
                    </Show>
                  </button>
                )}
              </For>
            </div>
            <div class="side-divider" />
          </Show>

          <Show when={recentFiles().length}>
            <div class="side-list-head side-list-head-row">
              <button
                class="side-sec-toggle"
                aria-expanded={recentOpen()}
                onClick={() => { setRecentOpen(!recentOpen()); void setSetting("recentOpen", !recentOpen()); }}
              >
                <Chevron open={recentOpen()} />
                <span>Recent</span>
              </button>
              <button class="side-clear-btn" title="Clear recent files" onClick={() => void clearRecentFiles()}>
                <TrashIcon /> Clear
              </button>
            </div>
            <Show when={recentOpen()}>
            <div class="side-recent" role="list">
              <For each={recentFiles().slice(0, 6)}>
                {(path) => (
                  <button
                    class="tree-item file"
                    role="treeitem"
                    classList={{ current: doc.filePath === path, missing: isMissing(path) }}
                    onClick={() => props.onOpenFile(path)}
                    onContextMenu={(e) => openPinMenu(e, path, false, true)}
                    title={isMissing(path) ? `Missing — ${path}` : path}
                  >
                    <Show when={isMissing(path)} fallback={<FileGlyph name={baseName(path)} />}>
                      <MissingIcon />
                    </Show>
                    <span class="tree-nm">{baseName(path)}</span>
                    <Show when={parentName(path)}>
                      <span class="tree-parent">{parentName(path)}</span>
                    </Show>
                    <Show when={isPinned(path)}><PinIcon /></Show>
                  </button>
                )}
              </For>
            </div>
            </Show>
            <div class="side-divider" />
          </Show>

          <div class="side-list-head side-list-head-row">
            <span>All files</span>
            <Show when={props.tree.length > 0}>
              <button
                class="side-clear-btn"
                title="Collapse all folders"
                onClick={() => { collapseAllFolders(); void saveOpenFolders(); }}
              >
                Collapse
              </button>
            </Show>
          </div>

          <Show when={props.tree.length > 0}>
            <div class="side-filter">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor"
                stroke-width="1.9" aria-hidden="true">
                <circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" />
              </svg>
              <input
                ref={filterEl}
                class="side-filter-input"
                type="text"
                spellcheck={false}
                autocomplete="off"
                placeholder="Filter files…"
                value={filter()}
                onInput={(e) => setFilter(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") { e.preventDefault(); setFilter(""); e.currentTarget.blur(); }
                }}
              />
              <Show when={filter()}>
                <button class="side-filter-clear" title="Clear filter" onClick={() => { setFilter(""); filterEl?.focus(); }}>
                  <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor"
                    stroke-width="2" stroke-linecap="round" aria-hidden="true">
                    <path d="M6 6l12 12M18 6 6 18" />
                  </svg>
                </button>
              </Show>
            </div>
          </Show>

          <div
            class="side-tree"
            role="tree"
            aria-label="Files"
            onKeyDown={onTreeKey}
            ref={treeEl}
          >
            <Show
              when={props.tree.length > 0}
              fallback={
                <div class="sidebar-empty">
                  <p>No folder open.</p>
                  <button class="ghost-btn" onClick={props.onOpenFolder}>Open folder…</button>
                </div>
              }
            >
              <Show
                when={rows().length}
                fallback={<div class="sidebar-empty"><p>No files match “{filter()}”.</p></div>}
              >
                {/* Windowing: only the visible slice is rendered, with spacers
                    standing in for the rest. Below WINDOW_MIN the whole list is
                    rendered so short trees keep native scroll-into-view. */}
                <div style={{ height: `${padTop()}px` }} aria-hidden="true" />
                <For each={visibleRows()}>
                  {(row) => (
                    <button
                      class="tree-item"
                      classList={{
                        dir: row.node.is_dir,
                        file: !row.node.is_dir,
                        open: row.node.is_dir && isFolderOpen(row.node.path),
                        current: !row.node.is_dir && doc.filePath === row.node.path,
                      }}
                      role="treeitem"
                      title={row.node.path}
                      data-path={row.node.path}
                      aria-level={row.depth + 1}
                      aria-posinset={row.pos}
                      aria-setsize={row.size}
                      aria-selected={!row.node.is_dir && doc.filePath === row.node.path}
                      aria-expanded={row.node.is_dir ? isFolderOpen(row.node.path) : undefined}
                      style={{ "padding-left": `${10 + row.depth * 14}px` }}
                      onClick={() => {
                        if (row.node.is_dir) { toggleFolder(row.node.path); void saveOpenFolders(); }
                        else props.onOpenFile(row.node.path);
                      }}
                      onContextMenu={(e) => openPinMenu(e, row.node.path, row.node.is_dir)}
                    >
                      <Show when={row.node.is_dir} fallback={<span class="tree-indent" aria-hidden="true" />}>
                        <Chevron open={isFolderOpen(row.node.path)} />
                      </Show>
                      <Show when={!row.node.is_dir} fallback={<FolderIcon />}>
                        <FileGlyph name={row.node.name} />
                      </Show>
                      <span class="tree-nm">{row.node.name}</span>
                      <Show when={isPinned(row.node.path)}><PinIcon /></Show>
                      <Show when={doc.filePath === row.node.path && doc.dirty}>
                        <span class="tree-dot" aria-label="Unsaved changes" />
                      </Show>
                    </button>
                  )}
                </For>
                <div style={{ height: `${padBottom()}px` }} aria-hidden="true" />
              </Show>
            </Show>
          </div>
        </Show>

        {/* --- Outline --- */}
        <Show when={sidebarTab() === "outline"}>
          <Show when={headings().length}>
            <div class="side-list-head">Outline</div>
          </Show>
          <div class="side-outline" role="tree" aria-label="Outline" onKeyDown={onNav}>
            <Show when={headings().length} fallback={<div class="sidebar-empty"><p>No headings yet.</p></div>}>
              <For each={headings()}>
                {(h, i) => (
                  <button
                    class="out-row"
                    role="treeitem"
                    classList={{ active: i() === activeHeading(), top: h.level <= baseLevel() }}
                    aria-current={i() === activeHeading() ? "true" : undefined}
                    // Depth drives indent in CSS so the step stays in one place.
                    style={{ "--depth": Math.min(Math.max(h.level - baseLevel(), 0), 5) }}
                    onClick={() => props.onJump(h.blockIndex)}
                  >
                    <span class="out-text">{h.text}</span>
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
              onMouseDown={(e) => { e.preventDefault(); void newFileNear(m().path, m().isDir); setPinMenu(null); }}
            >
              <span class="ctx-label">New file here…</span>
            </button>
            <Show when={!m().isDir}>
              <button
                class="ctx-item"
                onMouseDown={(e) => { e.preventDefault(); void togglePin(m().path); setPinMenu(null); }}
              >
                <PinIcon />
                <span class="ctx-label">{isPinned(m().path) ? "Unpin" : "Pin to top"}</span>
              </button>
            </Show>
            <Show when={m().recent}>
              <button
                class="ctx-item"
                onMouseDown={(e) => { e.preventDefault(); void removeRecentFile(m().path); setPinMenu(null); }}
              >
                <span class="ctx-label">Remove from Recent</span>
              </button>
            </Show>
            <div class="ctx-sep" />
            <button
              class="ctx-item"
              onMouseDown={(e) => { e.preventDefault(); void renamePath(m().path); setPinMenu(null); }}
            >
              <span class="ctx-label">Rename…</span>
            </button>
            <button
              class="ctx-item"
              onMouseDown={(e) => { e.preventDefault(); void copyPath(m().path); setPinMenu(null); }}
            >
              <span class="ctx-label">Copy path</span>
            </button>
            <button
              class="ctx-item"
              onMouseDown={(e) => { e.preventDefault(); void revealPath(m().path); setPinMenu(null); }}
            >
              <span class="ctx-label">Reveal in file manager</span>
            </button>
            <Show when={!m().isDir}>
              <div class="ctx-sep" />
              <button
                class="ctx-item"
                onMouseDown={(e) => { e.preventDefault(); void deletePath(m().path); setPinMenu(null); }}
              >
                <TrashIcon />
                <span class="ctx-label">Delete…</span>
              </button>
            </Show>
          </div>
        )}
      </Show>

      {/* ===== footer ===== */}

    </aside>
  );
}
