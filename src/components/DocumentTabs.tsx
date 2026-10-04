import { For, createEffect, createSignal, onCleanup } from "solid-js";
import { activeTabId, openTabs, openDocument, switchTab, moveTab } from "../store";
import { closeTab } from "../commands";
import { tabDragPosition } from "../tabdrag";

export default function DocumentTabs() {
  let list: HTMLDivElement | undefined;
  const [announcement, setAnnouncement] = createSignal("");
  const announceMove = (id: number) => {
    const tabs = openTabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    if (index >= 0) setAnnouncement(`${tabs[index].name}, tab ${index + 1} of ${tabs.length}`);
  };
  const [dragging, setDragging] = createSignal<number | null>(null);
  const [dropIndex, setDropIndex] = createSignal(-1);
  let pointer: { id: number; tab: number; startX: number; x: number; scroll: number } | null = null;
  let geometry: { id: number; el: HTMLElement; left: number; width: number }[] = [];
  let frame = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let settling = false;
  let suppressClick = false;
  const clearDrag = () => {
    for (const item of geometry) {
      item.el.style.removeProperty("transform");
      item.el.classList.remove("tab-sliding", "tab-settling");
    }
    geometry = [];
    setDragging(null);
    setDropIndex(-1);
    settling = false;
  };
  const destinations = (index: number) => {
    const moving = geometry.find((item) => item.id === dragging());
    const order = geometry.filter((item) => item !== moving);
    if (moving) order.splice(index, 0, moving);
    let left = geometry[0]?.left ?? 0;
    return order.map((item) => {
      const offset = left - item.left;
      left += item.width;
      return { ...item, offset };
    });
  };
  const updateDrop = () => {
    if (!list || !pointer) return;
    const moving = geometry.find((item) => item.id === pointer!.tab);
    if (!moving) return;
    const delta = pointer.x - pointer.startX + list.scrollLeft - pointer.scroll;
    const position = tabDragPosition(geometry, moving.id, delta);
    if (!position) return;
    const { offset, index } = position;
    setDropIndex(index);
    for (const item of destinations(index)) {
      item.el.style.transform = `translateX(${item.id === moving.id ? offset : item.offset}px)`;
    }
  };
  const autoScroll = () => {
    if (!list || !pointer || dragging() === null) return;
    const rect = list.getBoundingClientRect();
    const x = pointer.x;
    list.scrollLeft += x < rect.left + 28 ? -8 : x > rect.right - 28 ? 8 : 0;
    updateDrop();
    frame = requestAnimationFrame(autoScroll);
  };
  const finishDrag = (commit: boolean) => {
    if (settling) return;
    cancelAnimationFrame(frame);
    const id = dragging();
    const target = dropIndex();
    pointer = null;
    if (id === null) return;
    settling = true;
    const index = commit ? target : geometry.findIndex((item) => item.id === id);
    for (const item of destinations(index)) {
      item.el.classList.add("tab-settling");
      item.el.style.transform = `translateX(${item.offset}px)`;
    }
    // Finish the slide before committing DOM order: tabs never jump between
    // their pointer position and the final layout, even at unequal widths.
    settleTimer = setTimeout(() => {
      clearDrag();
      if (commit && target >= 0) { moveTab(id, target); announceMove(id); }
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
  };
  onCleanup(() => { cancelAnimationFrame(frame); clearTimeout(settleTimer); });
  createEffect(() => {
    const id = activeTabId();
    queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-tab-id="${id}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" }));
  });
  const navigate = (e: KeyboardEvent, id: number) => {
    const tabs = openTabs();
    const index = tabs.findIndex((tab) => tab.id === id);
    // Deletable tabs (WAI-ARIA APG): Delete closes the focused tab. The ✕
    // button duplicates this for pointers, so it stays out of the tab list's
    // accessibility tree (a tab list may only own tabs).
    if (e.key === "Delete") {
      e.preventDefault();
      void closeTab(id);
      return;
    }
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      moveTab(id, index + (e.key === "ArrowLeft" ? -1 : 1));
      announceMove(id);
      queueMicrotask(() => list?.querySelector<HTMLButtonElement>(`[data-tab-id="${id}"] [role="tab"]`)?.focus());
      return;
    }
    let next: number;
    if (e.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    switchTab(tabs[next].id);
    queueMicrotask(() => list?.querySelector<HTMLButtonElement>(`[data-tab-id="${tabs[next].id}"] [role="tab"]`)?.focus());
  };
  return (
    <div class="document-tabs" data-tauri-drag-region="deep">
      <span class="sr-only" role="status">{announcement()}</span>
      <div class="document-tab-list" role="tablist" aria-label="Open documents" ref={list}
        onWheel={(e) => {
          const rail = e.currentTarget;
          if (rail.scrollWidth <= rail.clientWidth || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
          // A regular mouse wheel scrolls the tabs too; horizontal trackpad
          // gestures retain the browser's native scrolling and inertia.
          e.preventDefault();
          const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? rail.clientWidth : 1;
          rail.scrollLeft += e.deltaY * unit;
        }}
      >
        <For each={openTabs()}>{(tab) => (
          <div class="document-tab" classList={{ selected: tab.id === activeTabId(), dragging: tab.id === dragging() }} data-tab-id={tab.id}>
            <button
              role="tab" id={`document-tab-${tab.id}`} aria-selected={tab.id === activeTabId()}
              aria-keyshortcuts="Delete Alt+ArrowLeft Alt+ArrowRight"
              aria-controls="document-panel" tabIndex={tab.id === activeTabId() ? 0 : -1}
              title={tab.filePath ?? "Not saved to a file yet"}
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => {
                if (e.button !== 0 || settling) return;
                suppressClick = false;
                pointer = { id: e.pointerId, tab: tab.id, startX: e.clientX, x: e.clientX, scroll: list?.scrollLeft ?? 0 };
                e.currentTarget.setPointerCapture(e.pointerId);
              }}
              onPointerMove={(e) => {
                if (!pointer || pointer.id !== e.pointerId) return;
                pointer.x = e.clientX;
                if (dragging() === null && Math.abs(pointer.x - pointer.startX) >= 5) {
                  geometry = [...list!.querySelectorAll<HTMLElement>("[data-tab-id]")].map((el) => ({
                    id: Number(el.dataset.tabId), el, left: el.offsetLeft, width: el.getBoundingClientRect().width,
                  }));
                  for (const item of geometry) item.el.classList.add("tab-sliding");
                  setDragging(tab.id);
                  suppressClick = true;
                  updateDrop();
                  frame = requestAnimationFrame(autoScroll);
                }
                if (dragging() !== null) { e.preventDefault(); updateDrop(); }
              }}
              onPointerUp={() => finishDrag(true)}
              onPointerCancel={() => finishDrag(false)}
              onLostPointerCapture={() => finishDrag(false)}
              onClick={() => { if (!suppressClick) switchTab(tab.id); suppressClick = false; }}
              onKeyDown={(e) => { if (e.key === "Escape") finishDrag(false); else navigate(e, tab.id); }}
            >
              <span class="document-tab-name">{tab.name}</span>
              <span class="document-tab-dirty" classList={{ dirty: tab.dirty }} aria-label={tab.dirty ? "Unsaved changes" : undefined} />
            </button>
            <button class="document-tab-close" tabIndex={-1} aria-hidden="true" title={`Close ${tab.name} (Delete)`}
              onMouseDown={(e) => e.preventDefault()} onClick={() => void closeTab(tab.id)}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
            </button>
          </div>
        )}</For>
      </div>
      <button class="document-tab-new" title="New tab (Cmd/Ctrl+T)" aria-label="New tab"
        onMouseDown={(e) => e.preventDefault()} onClick={() => openDocument("", null)}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M8 3v10M3 8h10" /></svg>
      </button>
    </div>
  );
}
