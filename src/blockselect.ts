import { doc, setActive } from "./store";
import { mapRenderedPrefixToSource } from "./livesource";

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

/** A selection boundary in the document: a block and an offset in its source. */
export interface SourcePoint { block: number; offset: number }

/** Map one DOM boundary point to a source position. */
function sourcePoint(blocks: Element[], node: Node, offset: number, isEnd: boolean): SourcePoint | null {
  const el = node instanceof Element ? node : node.parentElement;
  const blockEl = el?.closest(BLOCK);
  if (!blockEl) {
    // A boundary on the page itself (Select All): before the first block or
    // after the last one.
    if (!el?.closest(PAGE) && !(node instanceof Element && node.matches(PAGE))) return null;
    const last = doc.blocks.length - 1;
    return isEnd ? { block: last, offset: doc.blocks[last]?.text.length ?? 0 } : { block: 0, offset: 0 };
  }
  const block = blocks.indexOf(blockEl);
  const text = doc.blocks[block]?.text ?? "";
  // The block being edited holds its source verbatim; a rendered one maps its
  // visible text back onto the source.
  const host = blockEl.querySelector(".source") ?? blockEl.querySelector(".rendered");
  if (!host || !host.contains(node)) {
    // Block chrome (toolbars, the gutter): pick the block edge.
    return { block, offset: isEnd ? text.length : 0 };
  }
  const r = document.createRange();
  r.selectNodeContents(host);
  r.setEnd(node, offset);
  const prefix = r.toString();
  const at = host.classList.contains("source") ? prefix.length : mapRenderedPrefixToSource(text, prefix);
  return { block, offset: Math.min(at, text.length) };
}

/**
 * The selection as source positions, for editing it from outside a block:
 * whenever it is not wholly inside the block being edited (that block's own
 * handlers own those). Covers a selection across blocks, and one dragged
 * inside a rendered block that isn't being edited.
 */
export function selectedSourceRange(): { start: SourcePoint; end: SourcePoint } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  const range = sel.getRangeAt(0);
  const page = document.querySelector(PAGE);
  if (!page || !page.contains(range.commonAncestorContainer)) return null;
  const common = range.commonAncestorContainer;
  const commonEl = common instanceof Element ? common : common.parentElement;
  if (commonEl?.closest(".block.active .source")) return null;
  const blocks = [...document.querySelectorAll(BLOCK)];
  const start = sourcePoint(blocks, range.startContainer, range.startOffset, false);
  const end = sourcePoint(blocks, range.endContainer, range.endOffset, true);
  if (!start || !end) return null;
  if (end.block < start.block || (end.block === start.block && end.offset <= start.offset)) return null;
  return { start, end };
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
