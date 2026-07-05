import { setActive } from "./store";

// Blocks are separate render/edit hosts, so a native selection can't span the
// active (contenteditable) block. These helpers drive a document-wide selection
// by keeping every block a plain rendered node while selecting across them.

const PAGE = ".editor .page";
const BLOCK = ".editor .page > .block";

/** Select the whole document: deactivate the active block (so every block is a
 *  plain rendered node), then span the page with one native selection. */
export function selectAllDocument(): void {
  setActive(-1);
  // Deactivation re-renders the active block; wait a frame before selecting.
  requestAnimationFrame(() => {
    const page = document.querySelector(PAGE);
    const sel = window.getSelection();
    if (!page || !sel) return;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(page);
    sel.addRange(range);
  });
}

/** Inclusive block index range the current selection touches, but only when it
 *  spans a block boundary. Returns null for a collapsed or single-block
 *  selection (those are left to the browser's native handling). */
export function selectedBlockRange(): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const blocks = [...document.querySelectorAll(BLOCK)];
  let start = -1;
  let end = -1;
  blocks.forEach((b, i) => {
    if (sel.containsNode(b, true)) {
      if (start < 0) start = i;
      end = i;
    }
  });
  return start >= 0 && end > start ? { start, end } : null;
}
