import { batch, createSignal } from "solid-js";
import { doc } from "./store";

/**
 * Windowed rendering for long documents (issue #6). Every block keeps its
 * `.block` element, so code that finds a block by index or position still
 * works, but a block far outside the viewport renders an empty placeholder
 * of its last measured (or estimated) height instead of its HTML. That skips
 * rendering it on open and laying it out on every keystroke.
 *
 * Features that read every block's rendered text (find, print) hold all
 * blocks rendered while they need them.
 */

/** Below this many blocks everything renders: windowing pays off only on long documents. */
export const WINDOW_MIN_BLOCKS = 400;
/** Blocks rendered before the first visibility check, enough to fill a screen. */
const INITIAL_BLOCKS = 60;
/** How far beyond the viewport blocks stay rendered, as a share of its height. */
const MARGIN = "150% 0px";

const [holds, setHolds] = createSignal<ReadonlySet<string>>(new Set());

// Without IntersectionObserver (jsdom in unit tests) every block renders.
const supported = typeof IntersectionObserver !== "undefined";

/** Whether off-screen blocks are currently placeholders. */
export const windowing = () => supported && holds().size === 0 && doc.blocks.length >= WINDOW_MIN_BLOCKS;

/** Whether a block created at `index` renders before its first visibility
 *  check: the top of a document being opened, or blocks an edit creates
 *  around the one being edited (a split, a paste, an undo). */
export const startsNear = (index: number) =>
  index < INITIAL_BLOCKS || Math.abs(index - doc.activeIndex) < INITIAL_BLOCKS / 2;

interface Watched {
  id: number;
  text: () => string;
  /** Whether the block renders its content (not a placeholder) right now. */
  shown: () => boolean;
  setNear: (near: boolean) => void;
}

const watched = new Map<Element, Watched>();
let observer: IntersectionObserver | null = null;
let observerRoot: Element | null = null;

/** Measured heights by block id, valid while the block's text is unchanged.
 *  Kept across tab switches, which remount every block. */
const heights = new Map<number, { text: string; h: number }>();
/** Pixels per estimated line, calibrated from blocks measured so far. */
let linePx = 30;
let measuredLines = 0;
let measuredPx = 0;

function estimatedLines(text: string): number {
  let lines = 0;
  for (const line of text.split("\n")) lines += Math.max(1, Math.ceil(line.length / 90));
  return lines;
}

/** Placeholder height for a block that isn't rendered. */
export function placeholderHeight(id: number, text: string): number {
  const known = heights.get(id);
  return known && known.text === text ? known.h : Math.round(estimatedLines(text) * linePx);
}

/** A block's height including the gap to the next one (block margins
 *  collapse through `.block`, so its own box leaves the gap out). */
function measure(el: Element): number {
  const top = el.getBoundingClientRect().top;
  const next = el.nextElementSibling;
  return next ? next.getBoundingClientRect().top - top : el.getBoundingClientRect().height;
}

function remember(w: Watched, h: number) {
  if (h <= 0) return;
  const text = w.text();
  heights.set(w.id, { text, h });
  const lines = estimatedLines(text);
  measuredLines += lines;
  measuredPx += h;
  linePx = measuredPx / measuredLines;
}

/** Whether the user is working inside a block: a selection or focus in it
 *  must not lose its DOM when the block scrolls away. */
function inUse(el: Element): boolean {
  const sel = window.getSelection();
  return (!!sel && sel.rangeCount > 0 && sel.containsNode(el, true)) || el.contains(document.activeElement);
}

function onEntries(entries: IntersectionObserverEntry[]) {
  // Read every measurement before changing anything, so layout runs once.
  const changes: { w: Watched; near: boolean }[] = [];
  for (const e of entries) {
    const w = watched.get(e.target);
    if (!w) continue;
    const near = e.isIntersecting;
    if (!near && w.shown() && windowing()) {
      if (inUse(e.target)) continue;
      remember(w, measure(e.target));
    }
    changes.push({ w, near });
  }
  batch(() => { for (const c of changes) c.w.setNear(c.near); });
  // Blocks above and below can change by amounts that cancel out, leaving
  // the page's height (and so the resize observer) unchanged.
  restoreAnchor();
}

/*
 * Scroll anchoring. A block rendering above the viewport, or turning back
 * into a placeholder, changes height and would push the text being read up
 * or down. Native scroll anchoring doesn't cover this in WebKit, so while
 * windowing it is switched off and done here in every engine: remember where
 * the block at the top of the viewport sits after each scroll, and whenever
 * the page changes height, scroll by however far that block moved.
 */
let anchor: { el: Element; top: number } | null = null;
let page: Element | null = null;
const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => restoreAnchor());

/** The first block reaching below the viewport's top edge, found by bisection. */
function saveAnchor() {
  anchor = null;
  if (!observerRoot || !page) return;
  const on = windowing();
  const style = (observerRoot as HTMLElement).style;
  if (style.overflowAnchor !== (on ? "none" : "")) style.overflowAnchor = on ? "none" : "";
  if (!on) return;
  const viewTop = observerRoot.getBoundingClientRect().top;
  const blocks = page.children;
  let lo = 0;
  let hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].getBoundingClientRect().bottom > viewTop) hi = mid;
    else lo = mid + 1;
  }
  const el = blocks[lo];
  if (el) anchor = { el, top: el.getBoundingClientRect().top };
}

function restoreAnchor() {
  if (anchor && anchor.el.isConnected && observerRoot && windowing()) {
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) >= 1) observerRoot.scrollTop += delta;
  }
  saveAnchor();
}

/** Track a block's distance from the viewport; returns the cleanup. */
export function watchBlock(el: HTMLElement, w: Watched): () => void {
  if (!supported) return () => {};
  const root = el.closest(".scroll");
  if (!observer || observerRoot !== root) {
    observer?.disconnect();
    observerRoot?.removeEventListener("scroll", saveAnchor);
    observerRoot = root;
    observer = new IntersectionObserver(onEntries, { root, rootMargin: MARGIN });
    for (const other of watched.keys()) observer.observe(other);
    root?.addEventListener("scroll", saveAnchor, { passive: true });
  }
  if (el.parentElement && el.parentElement !== page) {
    if (page) resizes?.unobserve(page);
    page = el.parentElement;
    resizes?.observe(page);
  }
  watched.set(el, w);
  observer.observe(el);
  return () => {
    watched.delete(el);
    observer?.unobserve(el);
  };
}

/** Render every block while `reason` holds (find, print), or let windowing
 *  resume. Rendering resumes from heights measured as the hold ends. */
export function holdAllBlocks(reason: string, on: boolean) {
  const next = new Set(holds());
  if (on === next.has(reason)) return;
  if (on) next.add(reason);
  else {
    next.delete(reason);
    if (next.size === 0) {
      const all = [...watched].filter(([, w]) => w.shown());
      const hs = all.map(([el]) => measure(el));
      all.forEach(([, w], i) => remember(w, hs[i]));
    }
  }
  setHolds(next);
}

/** Print the editor with every block rendered. */
export function printDocument() {
  holdAllBlocks("print", true);
  window.print();
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeprint", () => holdAllBlocks("print", true));
  window.addEventListener("afterprint", () => holdAllBlocks("print", false));
}
