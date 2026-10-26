import { doc, setSourceMode, sourceMode } from "./store";
import { holdPosition } from "./virtualize";

/**
 * Switching between Live and Source keeps the reading position: both views
 * scroll in the same `.scroll` element, and swapping one for the other used
 * to leave it wherever the old scroll offset happened to land (usually the
 * top). The position is carried as the block at the top of the viewport and
 * how far into it the view sits, measured in whichever view is showing.
 */
interface Anchor { block: number; fraction: number }

const scroller = () => document.querySelector<HTMLElement>(".scroll");

/** Block tops (and the end of the last block) in the Live view, relative to the scroller's content. */
function liveTops(scroll: HTMLElement): number[] | null {
  const blocks = scroll.querySelectorAll<HTMLElement>(".editor .page > .block");
  if (!blocks.length) return null;
  const base = scroll.getBoundingClientRect().top - scroll.scrollTop;
  const tops = [...blocks].map((b) => b.getBoundingClientRect().top - base);
  const last = blocks[blocks.length - 1].getBoundingClientRect();
  tops.push(last.bottom - base);
  return tops;
}

/**
 * Block tops in the Source textarea, relative to the scroller's content. The
 * textarea can't report where a character sits, so a hidden copy with the
 * same metrics, with a marker at each block's start, is laid out once.
 */
function sourceTops(scroll: HTMLElement): number[] | null {
  const area = scroll.querySelector<HTMLTextAreaElement>("textarea.source-full");
  if (!area?.parentElement) return null;
  const style = getComputedStyle(area);
  const mirror = document.createElement("div");
  for (const prop of [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontFeatureSettings", "fontVariantLigatures",
    "lineHeight", "letterSpacing", "wordSpacing", "tabSize", "textIndent", "whiteSpace", "overflowWrap", "wordBreak",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "borderStyle", "boxSizing",
  ] as const) mirror.style[prop] = style[prop];
  const rect = area.getBoundingClientRect();
  Object.assign(mirror.style, {
    position: "absolute", visibility: "hidden", pointerEvents: "none",
    left: "0", top: "0", width: `${rect.width}px`, height: "auto",
  });
  // Mark where each block starts in the textarea's own text (which may hold
  // blank lines the block model normalizes away).
  const value = area.value;
  const marks: HTMLElement[] = [];
  let at = 0;
  for (const block of doc.blocks) {
    const found = value.indexOf(block.text, at);
    const start = found < 0 ? at : found;
    if (start > at) mirror.append(value.slice(at, start));
    const mark = document.createElement("span");
    mirror.append(mark);
    marks.push(mark);
    at = start;
  }
  mirror.append(value.slice(at) + "​");
  area.parentElement.append(mirror);
  const origin = mirror.getBoundingClientRect().top;
  const base = rect.top - scroll.getBoundingClientRect().top + scroll.scrollTop;
  const tops = marks.map((m) => base + m.getBoundingClientRect().top - origin);
  tops.push(base + mirror.getBoundingClientRect().height);
  mirror.remove();
  return tops;
}

function capture(scroll: HTMLElement): Anchor | null {
  const tops = sourceMode() ? sourceTops(scroll) : liveTops(scroll);
  if (!tops || tops.length < 2) return null;
  const y = scroll.scrollTop;
  let lo = 0;
  let hi = tops.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (tops[mid] <= y) lo = mid;
    else hi = mid - 1;
  }
  const span = tops[lo + 1] - tops[lo];
  return { block: lo, fraction: span > 0 ? Math.min(1, Math.max(0, (y - tops[lo]) / span)) : 0 };
}

function restore(scroll: HTMLElement, anchor: Anchor) {
  const tops = sourceMode() ? sourceTops(scroll) : liveTops(scroll);
  if (!tops || tops.length < 2) return;
  const i = Math.min(anchor.block, tops.length - 2);
  scroll.scrollTop = tops[i] + anchor.fraction * (tops[i + 1] - tops[i]);
  if (!sourceMode()) holdPosition();
}

/** Show Source (`true`) or Live (`false`) at the same place in the document. */
export function showSource(source: boolean) {
  if (source === sourceMode()) return;
  const scroll = scroller();
  const anchor = scroll && scroll.scrollTop > 0 ? capture(scroll) : null;
  setSourceMode(source);
  if (!anchor) return;
  // The new view renders synchronously; its textarea fits its content on a
  // microtask, so measure on the next frame.
  requestAnimationFrame(() => {
    const now = scroller();
    if (now) restore(now, anchor);
  });
}
