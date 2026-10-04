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
    <path fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"
      d="M4 1.6h5L12.4 5v9.4H4z M9 1.6V5h3.4" />
  </svg>
);
const TextFileIcon = () => (
  <svg class="file-icon" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"
      d="M4 1.6h5L12.4 5v9.4H4z M9 1.6V5h3.4" />
    <path fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round"
      d="M5.7 8h4.6 M5.7 10.2h4.6 M5.7 12.4h2.8" />
  </svg>
);
const FolderIcon = () => (
  <svg class="folder-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <path fill="none" stroke="currentColor" stroke-width="1.35" stroke-linejoin="round"
      d="M1.7 4c0-.5.4-.9.9-.9h2.7l1.2 1.3h6.9c.5 0 .9.4.9.9v6.7c0 .5-.4.9-.9.9H2.6c-.5 0-.9-.4-.9-.9z" />
  </svg>
);
const Chevron = (props: { open: boolean }) => (
  <svg class="tree-chevron" classList={{ open: props.open }} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="m9 6 6 6-6 6" />
  </svg>
);
// One 16px grid and stroke weight keeps the sidebar symbols crisp together.
const SidebarIcon = (p: { name: "files" | "outline" | "search" | "folder" | "open" | "new"; class?: string }) => (
  <svg class={p.class} viewBox="0 0 16 16" width="16" height="16" fill="none"
    stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {p.name === "files" && <>
      <rect x="5" y="1.75" width="8.25" height="10.5" rx="1.25" />
      <path d="M3 4H2.75a1 1 0 0 0-1 1v8.25a1 1 0 0 0 1 1H10" />
      <path d="M7.5 5h3.25M7.5 7.75h3.25" />
    </>}
    {p.name === "outline" && <>
      <path d="M2 3h2M6.5 3H14M6.5 6.25H12M2 9.5h2M6.5 9.5H14M6.5 12.75H12" />
    </>}
    {p.name === "search" && <>
      <circle cx="6.75" cy="6.75" r="4.5" /><path d="m10.1 10.1 3.65 3.65" />
    </>}
    {p.name === "folder" && <>
      <path d="M2 4.75V3.5c0-.7.55-1.25 1.25-1.25h3l1.5 1.5h5c.7 0 1.25.55 1.25 1.25v6.75c0 .7-.55 1.25-1.25 1.25h-9.5C2.55 13 2 12.45 2 11.75v-7Z" />
      <path d="M2 5.25h12" />
    </>}
    {p.name === "open" && <>
      <path d="M1.75 11.75V3.5c0-.7.55-1.25 1.25-1.25h3l1.5 1.5H12c.7 0 1.25.55 1.25 1.25v.75" />
      <path d="M3.75 7h9.6c.65 0 1.1.6.95 1.2l-1 4a1.1 1.1 0 0 1-1.05.8H2.75a1 1 0 0 1-.98-1.2l1-4A1 1 0 0 1 3.75 7Z" />
    </>}
    {p.name === "new" && <>
      <path d="M8.5 1.75H3.25A1.25 1.25 0 0 0 2 3v10a1.25 1.25 0 0 0 1.25 1.25h7.5A1.25 1.25 0 0 0 12 13V5.25Z" />
      <path d="M8.5 1.75v3.5H12M7 7.5v4M5 9.5h4" />
    </>}
  </svg>
);
const TabFilesIcon = () => <SidebarIcon name="files" class="side-tab-ic" />;
const TabOutlineIcon = () => <SidebarIcon name="outline" class="side-tab-ic" />;
const TabSearchIcon = () => <SidebarIcon name="search" class="side-tab-ic" />;

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
const ROW_H = 26;
/** Below this many rows, render everything (short trees keep native behaviour). */
const WINDOW_MIN = 300;
/** Extra rows above/below the viewport, so fast scrolling doesn't show gaps. */
const OVERSCAN = 12;

export default function Sidebar(props: Props) {
  const [activeHeading, setActiveHeading] = createSignal(-1);
  const [filter, setFilter] = createSignal("");
  const [recentOpen, setRecentOpen] = createSignal(getSetting("recentOpen", true));
  const [scrollTop, setScrollTop] = createSignal(0);
  /** The tree's top within its scroller (Recent/Pinned sit above it). */
  const [treeOffset, setTreeOffset] = createSignal(0);
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
    windowed() ? Math.max(0, Math.floor((scrollTop() - treeOffset()) / ROW_H) - OVERSCAN) : 0,
  );
  const lastIdx = createMemo(() =>
    windowed()
      ? Math.min(rows().length, Math.ceil((scrollTop() - treeOffset() + viewH()) / ROW_H) + OVERSCAN)
      : rows().length,
  );
  /** scrollTop that centres row `i` in the scroller. */
  const scrollTopFor = (i: number, scroller: HTMLElement) =>
    Math.max(0, treeOffset() + i * ROW_H + ROW_H / 2 - scroller.clientHeight / 2);
  const visibleRows = createMemo(() => rows().slice(firstIdx(), lastIdx()));
  /**
   * Keyboard focus in the tree, by path: one Tab stop for the whole tree
   * (roving tabindex), and navigation over the logical rows, so it reaches
   * rows the windowing hasn't rendered yet.
   */
  const [focusPath, setFocusPath] = createSignal<string | null>(null);
  const tabStop = createMemo(() => {
    const vis = visibleRows();
    const want = focusPath() ?? doc.filePath;
    return vis.some((r) => r.node.path === want) ? want : vis[0]?.node.path ?? null;
  });
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
    const measure = () => {
      if (treeEl) setTreeOffset(treeEl.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop);
    };
    // Re-measured on scroll too: collapsing Recent above the tree moves it.
    const onScroll = () => {
      measure();
      // Re-windowing can move the focused row's element and drop focus; put
      // it straight back so keys pressed right after still reach the tree.
      const hadFocus = !!treeEl?.contains(document.activeElement);
      setScrollTop(scroller.scrollTop);
      if (hadFocus && !treeEl?.contains(document.activeElement)) {
        const p = focusPath();
        if (p) treeEl?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)?.focus({ preventScroll: true });
      }
    };
    const ro = new ResizeObserver(() => { setViewH(scroller.clientHeight || 600); measure(); });
    if (treeEl) ro.observe(treeEl);
    measure();
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
          else if (scroller) scroller.scrollTop = scrollTopFor(idx, scroller);
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
  /** Focus the row at a logical index, scrolling it into existence if windowed. */
  const focusRow = (idx: number) => {
    const list = rows();
    if (!list.length) return;
    const i = Math.max(0, Math.min(idx, list.length - 1));
    const path = list[i].node.path;
    setFocusPath(path);
    const find = () => treeEl?.querySelector<HTMLElement>(`[data-path="${CSS.escape(path)}"]`);
    const el = find();
    if (el) {
      el.focus();
      el.scrollIntoView({ block: "nearest" });
      return;
    }
    const scroller = treeEl?.closest<HTMLElement>(".side-tab-body");
    if (scroller) {
      scroller.scrollTop = scrollTopFor(i, scroller);
      // Updating the signal renders the new window synchronously, so the row
      // exists now: focus it before the next key arrives.
      setScrollTop(scroller.scrollTop);
    }
    const now = find();
    if (now) now.focus({ preventScroll: true });
    else requestAnimationFrame(() => find()?.focus());
  };

  const onTreeKey = (e: KeyboardEvent) => {
    const list = rows();
    // Position comes from the tracked path, not whichever element has focus
    // (a row can be re-rendered by the windowing mid-navigation).
    const path = (document.activeElement as HTMLElement | null)?.dataset.path ?? focusPath();
    const i = path ? list.findIndex((r) => r.node.path === path) : -1;
    const row = list[i];

    switch (e.key) {
      case "ArrowDown": e.preventDefault(); return focusRow(i + 1);
      case "ArrowUp": e.preventDefault(); return focusRow(Math.max(0, i - 1));
      case "Home": e.preventDefault(); return focusRow(0);
      case "End": e.preventDefault(); return focusRow(list.length - 1);
      case "ArrowRight":
        if (!row?.node.is_dir) return;
        e.preventDefault();
        // Closed folder: open it. Open folder: move to its first child.
        // (Expanding rebuilds the rows, so focus is put back on this one.)
        if (!isFolderOpen(row.node.path)) { toggleFolder(row.node.path); void saveOpenFolders(); focusRow(i); }
        else if (list[i + 1]?.depth === row.depth + 1) focusRow(i + 1);
        return;
      case "ArrowLeft": {
        if (!row) return;
        e.preventDefault();
        // Open folder: close it. Anything else: move to its parent folder.
        if (row.node.is_dir && isFolderOpen(row.node.path)) { toggleFolder(row.node.path); void saveOpenFolders(); focusRow(i); return; }
        for (let k = i - 1; k >= 0; k--) if (list[k].depth === row.depth - 1) return focusRow(k);
        return;
      }
    }
    if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typeahead = now - typeaheadAt > 700 ? e.key : typeahead + e.key;
      typeaheadAt = now;
      const q = typeahead.toLowerCase();
      const from = i >= 0 ? i : 0;
      // A longer prefix may still match the current row: stay on it.
      for (let step = typeahead.length > 1 ? 0 : 1; step <= list.length; step++) {
        const k = (from + step) % list.length;
        if (list[k].node.name.toLowerCase().startsWith(q)) { e.preventDefault(); return focusRow(k); }
      }
    }
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
      id={`sidebar-view-${p.id}`}
      aria-controls="sidebar-view-panel"
      title={p.label}
      aria-selected={sidebarTab() === p.id}
      tabIndex={sidebarTab() === p.id ? 0 : -1}
      onKeyDown={(e) => {
        const ids = ["files", "outline", "search"] as const;
        const index = ids.indexOf(p.id);
        const next = e.key === "ArrowRight" ? (index + 1) % 3 : e.key === "ArrowLeft" ? (index + 2) % 3 : e.key === "Home" ? 0 : e.key === "End" ? 2 : -1;
        if (next < 0) return;
        e.preventDefault(); setSidebarTab(ids[next]);
        document.getElementById(`sidebar-view-${ids[next]}`)?.focus();
      }}
      classList={{ on: sidebarTab() === p.id }}
      onClick={() => setSidebarTab(p.id)}
    >
      {p.icon()}
      <span>{p.label}</span>
    </button>
  );

  return (
    <aside
      class="sidebar" id="workspace-sidebar" inert={!sidebarOpen()}
      classList={{ collapsed: !sidebarOpen() }}
      aria-hidden={!sidebarOpen()}
      style={{
        width: `${sidebarWidth()}px`,
        "margin-left": sidebarOpen() ? "0px" : `-${sidebarWidth()}px`,
      }}
    >
      <div class="sidebar-resize" title="Drag or use arrow keys to resize" onPointerDown={startResize}
        role="separator" aria-label="Sidebar width" aria-orientation="vertical" tabIndex={0}
        aria-valuenow={sidebarWidth()} aria-valuemin={clampSidebar(0)} aria-valuemax={clampSidebar(10000)}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          const width = clampSidebar(sidebarWidth() + (e.key === "ArrowLeft" ? -10 : 10));
          setSidebarWidth(width); void setSetting("sidebarWidth", width);
        }} />

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
        <SidebarIcon name="folder" class="side-ws-glyph" />
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
          <SidebarIcon name="open" />
        </button>
        <button class="side-icon-btn" title="New file" aria-label="New file" onClick={() => executeCommand("file.new")}>
          <SidebarIcon name="new" />
        </button>
      </div>

      {/* ===== sidebar views ===== */}
      <div class="side-tabs" role="tablist" aria-label="Sidebar views">
        <Tab id="files" icon={() => <TabFilesIcon />} label="Files" />
        <Tab id="outline" icon={() => <TabOutlineIcon />} label="Outline" />
        <Tab id="search" icon={() => <TabSearchIcon />} label="Find" />
      </div>

      {/* ===== tab body ===== */}
      <div class="side-tab-body scrollarea" id="sidebar-view-panel" role="tabpanel" aria-labelledby={`sidebar-view-${sidebarTab()}`}>
        {/* --- Files --- */}
        <Show when={sidebarTab() === "files"}>
          <Show when={pinnedFiles().length}>
            <div class="side-list-head side-list-head-row">
              <span>Pinned</span>
              <button class="side-clear-btn" title="Clear pinned files" aria-label="Clear pinned files" onClick={() => void clearPinned()}>
                <TrashIcon />
              </button>
            </div>
            <div class="side-recent" role="group" aria-label="Recent or pinned files">
              <For each={pinnedFiles()}>
                {(path) => (
                  <button
                    class="tree-item file pinned"
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
              <button class="side-clear-btn" title="Clear recent files" aria-label="Clear recent files" onClick={() => void clearRecentFiles()}>
                <TrashIcon />
              </button>
            </div>
            <Show when={recentOpen()}>
            <div class="side-recent" role="group" aria-label="Recent or pinned files">
              <For each={recentFiles().slice(0, 6)}>
                {(path) => (
                  <button
                    class="tree-item file"
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
                aria-label="Collapse all folders"
                onClick={() => { collapseAllFolders(); void saveOpenFolders(); }}
              >
                <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="m5 3 3 3 3-3M5 13l3-3 3 3M3 8h10" />
                </svg>
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
                aria-label="Filter files"
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
            role={props.tree.length > 0 ? "tree" : undefined}
            aria-label={props.tree.length > 0 ? "Files" : undefined}
            onKeyDown={onTreeKey}
            onFocusOut={(e) => {
              // Focus dropping to nothing means the focused row's element was
              // removed or moved by the windowing, not that the user left:
              // put it back on the same row so keyboard navigation carries on.
              if (e.relatedTarget) return;
              requestAnimationFrame(() => {
                const p = focusPath();
                if (p && document.activeElement === document.body) {
                  treeEl?.querySelector<HTMLElement>(`[data-path="${CSS.escape(p)}"]`)?.focus({ preventScroll: true });
                }
              });
            }}
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
                      tabIndex={row.node.path === tabStop() ? 0 : -1}
                      onFocus={() => setFocusPath(row.node.path)}
                      title={row.node.path}
                      data-path={row.node.path}
                      aria-level={row.depth + 1}
                      aria-posinset={row.pos}
                      aria-setsize={row.size}
                      aria-selected={!row.node.is_dir && doc.filePath === row.node.path}
                      aria-expanded={row.node.is_dir ? isFolderOpen(row.node.path) : undefined}
                      style={{ "padding-left": `${8 + row.depth * 16}px` }}
                      onClick={() => {
                        if (row.node.is_dir) {
                          toggleFolder(row.node.path);
                          void saveOpenFolders();
                          // Expanding rebuilds the rows; keep focus on this folder.
                          const at = rows().findIndex((r) => r.node.path === row.node.path);
                          if (at >= 0) focusRow(at);
                        } else props.onOpenFile(row.node.path);
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
          <div class="side-outline" role="group" aria-label="Outline" onKeyDown={onNav}>
            <Show when={headings().length} fallback={<div class="sidebar-empty"><p>No headings yet.</p></div>}>
              <For each={headings()}>
                {(h, i) => (
                  <button
                    class="out-row"
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
