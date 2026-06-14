import { Show, createSignal, createEffect } from "solid-js";
import { doc, fullText, updateBlock, renderEpoch } from "../store";
import { buildSearchRegex } from "../search";

/**
 * Live find: every match in the document is highlighted (CSS Custom
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
const [invalid, setInvalid] = createSignal(false);

// Search options (VS Code-style toggles).
const [useRegex, setUseRegex] = createSignal(false);
const [caseSensitive, setCaseSensitive] = createSignal(false);
const [wholeWord, setWholeWord] = createSignal(false);

let focusInput: (() => void) | undefined;
/** DOM ranges of all matches, refreshed by the highlight effect. */
let domMatches: Range[] = [];

export function openFind(replace = false) {
  setWithReplace(replace);
  setVisible(true);
  queueMicrotask(() => focusInput?.());
}

/** Open the find bar pre-filled with a query (used by the folder-search panel). */
export function openFindWith(q: string) {
  setQuery(q);
  setUseRegex(false);
  setVisible(true);
  queueMicrotask(() => focusInput?.());
}

export function closeFind() {
  setVisible(false);
}

/**
 * Build the active search regex from the query + option toggles, or null when
 * the query is empty or an invalid regex. Always global; case-insensitive
 * unless the case toggle is on; word-bounded when the whole-word toggle is on.
 */
function buildPattern(): RegExp | null {
  return buildSearchRegex(query(), {
    regex: useRegex(),
    caseSensitive: caseSensitive(),
    wholeWord: wholeWord(),
  });
}

/** Find query matches across each block's DOM text (whatever view it shows). */
function computeDomMatches(re: RegExp): Range[] {
  const out: Range[] = [];
  for (const block of document.querySelectorAll(".page .block")) {
    // Full block text with a node map so matches can span inline elements.
    const nodes: { node: Text; start: number }[] = [];
    let text = "";
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
      nodes.push({ node: n, start: text.length });
      text += n.data;
    }
    const at = (offset: number) => {
      let lo = 0;
      for (let i = 0; i < nodes.length; i++) if (nodes[i].start <= offset) lo = i;
      return { node: nodes[lo].node, offset: offset - nodes[lo].start };
    };
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while (out.length < 999 && (m = re.exec(text))) {
      if (m[0].length === 0) { re.lastIndex++; continue; } // skip empty matches
      const range = document.createRange();
      const s = at(m.index);
      const e = at(m.index + m[0].length);
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      out.push(range);
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
  const re = buildPattern();
  const n = matchCount();
  if (!re || !n) return;
  const idx = Math.min(cursor(), n - 1);
  const range = domMatches[idx];
  if (!range) return;
  const blockIndex = blockIndexOf(range);
  if (blockIndex < 0 || blockIndex >= doc.blocks.length) return;
  // Ordinal of this match within its block → same ordinal in the source.
  let ordinal = 0;
  for (let k = 0; k < idx; k++) if (blockIndexOf(domMatches[k]) === blockIndex) ordinal++;
  const source = doc.blocks[blockIndex].text;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  let seen = -1;
  let target: RegExpExecArray | null = null;
  while ((m = re.exec(source))) {
    if (m[0].length === 0) { re.lastIndex++; continue; }
    if (++seen === ordinal) { target = m; break; }
  }
  if (!target) return;
  // Regex mode expands $1/$& backreferences; plain mode inserts the text as-is.
  const replacement = useRegex()
    ? target[0].replace(new RegExp(re.source, caseSensitive() ? "" : "i"), replaceWith())
    : replaceWith();
  updateBlock(
    blockIndex,
    source.slice(0, target.index) + replacement + source.slice(target.index + target[0].length),
  );
}

function replaceAllMatches() {
  const re = buildPattern();
  if (!re) return;
  const rep = replaceWith();
  const regex = useRegex();
  doc.blocks.forEach((block, i) => {
    re.lastIndex = 0;
    if (!re.test(block.text)) return;
    // Plain mode replaces via a function so $ in the text isn't interpreted;
    // regex mode keeps the template so $1 backreferences work.
    const next = regex ? block.text.replace(re, rep) : block.text.replace(re, () => rep);
    updateBlock(i, next);
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
    // Read the option toggles so flipping any of them re-runs the search.
    void useRegex();
    void caseSensitive();
    void wholeWord();
    const re = buildPattern();
    const idx = cursor();
    const on = visible() && q.length > 0;
    setInvalid(on && useRegex() && re === null);
    const highlights = (window.CSS as typeof CSS & { highlights?: Map<string, unknown> }).highlights;
    if (!on || !re) {
      highlights?.delete("sarala-find");
      highlights?.delete("sarala-find-current");
      domMatches = [];
      setMatchCount(0);
      return;
    }
    domMatches = computeDomMatches(re);
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
    if (invalid()) return "Bad pattern";
    if (!matchCount()) return "0 / 0";
    return `${Math.min(cursor() + 1, matchCount())} / ${matchCount()}`;
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
            classList={{ invalid: invalid() }}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          <div class="findbar-toggles">
            <button class="find-toggle" classList={{ on: caseSensitive() }}
              title="Match case" onClick={() => setCaseSensitive(!caseSensitive())}>Aa</button>
            <button class="find-toggle" classList={{ on: wholeWord() }}
              title="Whole word" onClick={() => setWholeWord(!wholeWord())}>W</button>
            <button class="find-toggle mono" classList={{ on: useRegex() }}
              title="Use regular expression" onClick={() => setUseRegex(!useRegex())}>.*</button>
          </div>
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
