import { Show, createSignal, createEffect } from "solid-js";
import { doc, fullText, updateBlock, renderEpoch } from "../store";

/**
 * Typora-style find: every match in the document is highlighted (CSS Custom
 * Highlight API — pure painting, no DOM mutation, so the textContent caret
 * invariant is untouched), the current match gets a distinct style, and
 * Enter cycles while focus STAYS in the search input. Blocks are never
 * activated by searching.
 */

const [visible, setVisible] = createSignal(false);
const [withReplace, setWithReplace] = createSignal(false);
const [query, setQuery] = createSignal("");
const [replaceWith, setReplaceWith] = createSignal("");
const [cursor, setCursor] = createSignal(0);
const [matchCount, setMatchCount] = createSignal(0);

let focusInput: (() => void) | undefined;
/** DOM ranges of all matches, refreshed by the highlight effect. */
let domMatches: Range[] = [];

export function openFind(replace = false) {
  setWithReplace(replace);
  setVisible(true);
  queueMicrotask(() => focusInput?.());
}

export function closeFind() {
  setVisible(false);
}

/** Find query matches across each block's DOM text (whatever view it shows). */
function computeDomMatches(q: string): Range[] {
  const out: Range[] = [];
  const needle = q.toLowerCase();
  for (const block of document.querySelectorAll(".page .block")) {
    // Full block text with a node map so matches can span inline elements.
    const nodes: { node: Text; start: number }[] = [];
    let text = "";
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    const hay = text.toLowerCase();
    const at = (offset: number) => {
      let lo = 0;
      for (let i = 0; i < nodes.length; i++) if (nodes[i].start <= offset) lo = i;
      return { node: nodes[lo].node, offset: offset - nodes[lo].start };
    };
    let from = 0;
    while (out.length < 999) {
      const i = hay.indexOf(needle, from);
      if (i === -1) break;
      const range = document.createRange();
      const s = at(i);
      const e = at(i + needle.length);
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      out.push(range);
      from = i + Math.max(needle.length, 1);
    }
  }
  return out;
}

export function findNext(dir: 1 | -1 = 1) {
  const n = matchCount();
  if (!n) return;
  setCursor(((cursor() + dir) % n + n) % n);
}

/** Block index (into doc.blocks) of a DOM range, via element order. */
function blockIndexOf(range: Range): number {
  const block = (range.startContainer.parentElement as HTMLElement)?.closest(".block");
  return block ? [...document.querySelectorAll(".page .block")].indexOf(block) : -1;
}

function replaceCurrent() {
  const n = matchCount();
  if (!n || !query()) return;
  const idx = Math.min(cursor(), n - 1);
  const range = domMatches[idx];
  if (!range) return;
  const blockIndex = blockIndexOf(range);
  if (blockIndex < 0 || blockIndex >= doc.blocks.length) return;
  // Ordinal of this match within its block → same ordinal in the source.
  let ordinal = 0;
  for (let k = 0; k < idx; k++) if (blockIndexOf(domMatches[k]) === blockIndex) ordinal++;
  const source = doc.blocks[blockIndex].text;
  const hay = source.toLowerCase();
  const needle = query().toLowerCase();
  let at = -1;
  for (let k = 0, from = 0; k <= ordinal; k++) {
    at = hay.indexOf(needle, from);
    if (at === -1) return;
    from = at + Math.max(needle.length, 1);
  }
  updateBlock(blockIndex, source.slice(0, at) + replaceWith() + source.slice(at + needle.length));
}

function replaceAllMatches() {
  const q = query();
  if (!q) return;
  const pattern = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
  doc.blocks.forEach((block, i) => {
    if (pattern.test(block.text)) updateBlock(i, block.text.replace(pattern, replaceWith()));
  });
  setCursor(0);
}

export default function FindBar() {
  let inputEl: HTMLInputElement | undefined;
  focusInput = () => {
    inputEl?.focus();
    inputEl?.select();
  };

  createEffect(() => {
    query();
    setCursor(0);
  });

  // Paint all matches + the current one; track everything that changes the
  // DOM text (doc edits, block activation swaps, render-option flips).
  createEffect(() => {
    fullText();
    renderEpoch();
    void doc.activeIndex;
    const q = query();
    const idx = cursor();
    const on = visible() && q.length > 0;
    const highlights = (window.CSS as typeof CSS & { highlights?: Map<string, unknown> }).highlights;
    if (!on) {
      highlights?.delete("sarala-find");
      highlights?.delete("sarala-find-current");
      domMatches = [];
      setMatchCount(0);
      return;
    }
    domMatches = computeDomMatches(q);
    setMatchCount(domMatches.length);
    const current = domMatches[Math.min(idx, domMatches.length - 1)];
    if (highlights && "Highlight" in window) {
      const H = (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
      highlights.set("sarala-find", new H(...domMatches));
      if (current) highlights.set("sarala-find-current", new H(current));
      else highlights.delete("sarala-find-current");
    }
    // Keep the current match in view without activating anything.
    if (current) {
      const scroller = document.querySelector(".scroll");
      const rect = current.getBoundingClientRect();
      if (scroller && (rect.top < 80 || rect.bottom > scroller.clientHeight - 40)) {
        scroller.scrollTo({
          top: scroller.scrollTop + rect.top - scroller.clientHeight / 2,
          behavior: "instant" as ScrollBehavior,
        });
      }
    }
  });

  const count = () => {
    if (!query()) return "";
    if (!matchCount()) return "0 results";
    return `${Math.min(cursor() + 1, matchCount())} of ${matchCount()}`;
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); closeFind(); }
    if (e.key === "Enter") { e.preventDefault(); findNext(e.shiftKey ? -1 : 1); }
  };

  return (
    <Show when={visible()}>
      <div class="findbar">
        <div class="findbar-row">
          <input
            ref={inputEl}
            placeholder="Find"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <span class="findbar-count">{count()}</span>
          <button class="ghost-btn" title="Previous (Shift+Enter)" onClick={() => findNext(-1)}>↑</button>
          <button class="ghost-btn" title="Next (Enter)" onClick={() => findNext(1)}>↓</button>
          <button class="ghost-btn" title="Toggle replace" onClick={() => setWithReplace(!withReplace())}>⇄</button>
          <button class="ghost-btn" title="Close (Esc)" onClick={closeFind}>✕</button>
        </div>
        <Show when={withReplace()}>
          <div class="findbar-row">
            <input
              placeholder="Replace with"
              value={replaceWith()}
              onInput={(e) => setReplaceWith(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && closeFind()}
            />
            <button class="ghost-btn" onClick={replaceCurrent}>Replace</button>
            <button class="ghost-btn" onClick={replaceAllMatches}>All</button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
