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
/** How far beyond the viewport blocks stay rendered, in viewport heights. */
const MARGIN = 1.5;

const [holds, setHolds] = createSignal<ReadonlySet<string>>(new Set());

// Without layout (jsdom in unit tests, which also lacks IntersectionObserver)
// every block renders.
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
  /** Whether the block is within range of the viewport, as last set. */
  near: boolean;
  setNear: (near: boolean) => void;
}

const watched = new Map<Element, Watched>();
/** The watched blocks currently marked near. */
const nearBlocks = new Set<Element>();
let root: HTMLElement | null = null;

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

/*
 * Which blocks are near the viewport, recomputed after a scroll or a change
 * in the page, not observed: an IntersectionObserver on every block made
 * WebKit recompute 12,000 intersections on each rendering update, including
 * every blink of the caret, at a steady cost while the document sat idle.
 * Here a bisection finds the first block in range and the rest are walked
 * until one falls below it, so a pass touches only the blocks near the
 * viewport.
 */
let updateFrame = 0;
const scheduleUpdate = () => { if (!updateFrame) updateFrame = requestAnimationFrame(update); };

function update() {
  updateFrame = 0;
  if (!root || !page) return;
  const view = root.getBoundingClientRect();
  const top = view.top - view.height * MARGIN;
  const bottom = view.bottom + view.height * MARGIN;
  const blocks = page.children;
  let lo = 0;
  let hi = blocks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (blocks[mid].getBoundingClientRect().bottom > top) hi = mid;
    else lo = mid + 1;
  }
  const inRange = new Set<Element>();
  for (let i = lo; i < blocks.length && blocks[i].getBoundingClientRect().top < bottom; i++) inRange.add(blocks[i]);
  // Read every measurement before changing anything, so layout runs once.
  const changes: [Element, Watched, boolean][] = [];
  for (const el of inRange) {
    const w = watched.get(el);
    if (w && !w.near) changes.push([el, w, true]);
  }
  for (const el of nearBlocks) {
    const w = watched.get(el);
    if (!w || inRange.has(el)) continue;
    if (w.shown() && windowing()) {
      if (inUse(el)) continue;
      remember(w, measure(el));
    }
    changes.push([el, w, false]);
  }
  if (!changes.length) return;
  batch(() => {
    for (const [el, w, near] of changes) {
      w.near = near;
      if (near) nearBlocks.add(el);
      else nearBlocks.delete(el);
      w.setNear(near);
    }
  });
  // Blocks above and below can change by amounts that cancel out, leaving
  // the page's height (and so the resize observer) unchanged.
  restoreAnchor();
  // Rendered blocks have their real heights now, which can bring others
  // into range or push them out.
  scheduleUpdate();
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
const resizes = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => { restoreAnchor(); scheduleUpdate(); });

/** The first block reaching below the viewport's top edge, found by bisection. */
function saveAnchor() {
  anchor = null;
  if (!root || !page) return;
  const on = windowing();
  const style = root.style;
  if (style.overflowAnchor !== (on ? "none" : "")) style.overflowAnchor = on ? "none" : "";
  if (!on) return;
  const viewTop = root.getBoundingClientRect().top;
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

/** Hold the text now at the top of the viewport in place while blocks above
 *  it render or turn into placeholders, after scrolling it there in code. */
export function holdPosition() {
  saveAnchor();
  scheduleUpdate();
}

function restoreAnchor() {
  if (anchor && anchor.el.isConnected && root && windowing()) {
    const delta = anchor.el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(delta) >= 1) root.scrollTop += delta;
  }
  saveAnchor();
}

const onScroll = () => { saveAnchor(); scheduleUpdate(); };

/** Track a block's distance from the viewport; returns the cleanup. */
export function watchBlock(el: HTMLElement, w: Watched): () => void {
  if (!supported) return () => {};
  const scroller = el.closest<HTMLElement>(".scroll");
  if (scroller !== root) {
    root?.removeEventListener("scroll", onScroll);
    root = scroller;
    root?.addEventListener("scroll", onScroll, { passive: true });
  }
  if (el.parentElement && el.parentElement !== page) {
    if (page) resizes?.unobserve(page);
    page = el.parentElement;
    resizes?.observe(page);
  }
  watched.set(el, w);
  if (w.near) nearBlocks.add(el);
  scheduleUpdate();
  return () => {
    watched.delete(el);
    nearBlocks.delete(el);
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
  scheduleUpdate();
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
