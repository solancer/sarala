import { Show, batch, createSignal, createEffect, createComputed } from "solid-js";
import { unwrap } from "solid-js/store";
import { doc, fullText, updateBlock, renderEpoch, activeTabId } from "../store";
import { buildSearchRegex, locateHit, type SearchOptions } from "../search";
import { WINDOW_MIN_BLOCKS, holdAllBlocks, renderedEpoch, windowing } from "../virtualize";

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

/** A folder-search hit to land on once its document is showing. */
const [jump, setJump] = createSignal<{ path: string | null; hit: number } | null>(null);

let focusInput: (() => void) | undefined;
/** DOM ranges of all matches, refreshed by the highlight effect. In a windowed
 *  document, only those in blocks that are rendered. */
let domMatches: Range[] = [];
/** A windowed document's matches, found in its source (see sourceMatches). */
let sourceHits: { block: number; ordinal: number }[] = [];
const MAX_MATCHES = 999;

export function openFind(replace = false) {
  setWithReplace(replace);
  setVisible(true);
  queueMicrotask(() => focusInput?.());
}

/** Open the find bar on a folder-search hit: the same search, at that match. */
export function openFindWith(q: string, opts: SearchOptions, target: { path: string | null; hit: number }) {
  batch(() => {
    setQuery(q);
    setUseRegex(opts.regex);
    setCaseSensitive(opts.caseSensitive);
    setWholeWord(opts.wholeWord);
    setCursor(0);
    setJump(target);
    setVisible(true);
  });
  queueMicrotask(() => focusInput?.());
}

export function closeFind() {
  setJump(null);
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
  for (const block of document.querySelectorAll(".page .block:not(.placeholder)")) {
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
    while (out.length < MAX_MATCHES && (m = re.exec(text))) {
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

/**
 * Matches in a long document's source, so finding never renders the whole of
 * it: placeholders have no text to search, and rendering 40,000 blocks to get
 * some takes seconds. Text a render hides, like a link's URL, counts here.
 */
function sourceMatches(re: RegExp) {
  const out: typeof sourceHits = [];
  const blocks = unwrap(doc.blocks);
  for (let block = 0; block < blocks.length; block++) {
    re.lastIndex = 0;
    let ordinal = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(blocks[block].text))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out.push({ block, ordinal: ordinal++ });
      if (out.length >= MAX_MATCHES) return out;
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
  let blockIndex: number;
  let ordinal = 0;
  if (sourceHits.length) {
    ({ block: blockIndex, ordinal } = sourceHits[idx]);
  } else {
    const range = domMatches[idx];
    if (!range) return;
    blockIndex = blockIndexOf(range);
    if (blockIndex < 0 || blockIndex >= doc.blocks.length) return;
    // Ordinal of this match within its block → same ordinal in the source.
    for (let k = 0; k < idx; k++) if (blockIndexOf(domMatches[k]) === blockIndex) ordinal++;
  }
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

  // Matches are found in the rendered text, so a search renders every block
  // while it is open, except in a windowed document, searched in its source
  // instead (see sourceMatches). A computed runs before the effect below, so
  // the blocks are in the DOM by the time it searches.
  createComputed(() => holdAllBlocks("find", visible() && query().length > 0 && doc.blocks.length < WINDOW_MIN_BLOCKS));

  // What the highlight effect last scrolled to: it also runs as blocks render
  // during ordinary scrolling, which mustn't pull the view back to the match.
  let revealed = "";

  // Paint all matches + the current one; track everything that changes the
  // DOM text (doc edits, block activation swaps, render-option flips).
  createEffect(() => {
    if (!visible()) {
      const closed = (window.CSS as typeof CSS & { highlights?: Map<string, unknown> }).highlights;
      closed?.delete("sarala-find");
      closed?.delete("sarala-find-current");
      domMatches = [];
      sourceHits = [];
      setMatchCount(0);
      setInvalid(false);
      return;
    }
    fullText();
    renderEpoch();
    activeTabId();
    void doc.activeIndex;
    const long = windowing();
    if (long) renderedEpoch();
    const q = query();
    // Read the option toggles so flipping any of them re-runs the search.
    void useRegex();
    void caseSensitive();
    void wholeWord();
    const re = buildPattern();
    let idx = cursor();
    const on = visible() && q.length > 0;
    setInvalid(on && useRegex() && re === null);
    const highlights = (window.CSS as typeof CSS & { highlights?: Map<string, unknown> }).highlights;
    if (!on || !re) {
      highlights?.delete("sarala-find");
      highlights?.delete("sarala-find-current");
      domMatches = [];
      sourceHits = [];
      setMatchCount(0);
      return;
    }
    domMatches = computeDomMatches(re);
    sourceHits = long ? sourceMatches(re) : [];
    const total = long ? sourceHits.length : domMatches.length;
    setMatchCount(total);
    // A document opens after the search asked for it, so wait until it shows.
    const target = jump();
    if (target && target.path === doc.filePath && total) {
      const at = locateHit(unwrap(doc.blocks).map((b) => b.text), target.hit, re);
      if (at && long) idx = Math.max(sourceHits.findIndex((h) => h.block === at.block && h.ordinal >= at.ordinal), 0);
      else if (at) {
        const inBlock = domMatches.flatMap((range, i) => blockIndexOf(range) === at.block ? [i] : []);
        idx = inBlock[Math.min(at.ordinal, inBlock.length - 1)] ?? idx;
      }
      setJump(null);
      setCursor(idx);
    }
    let current: Range | undefined = domMatches[Math.min(idx, domMatches.length - 1)];
    let scrollToCurrent = !!current;
    if (long) {
      const hit = sourceHits[Math.min(idx, sourceHits.length - 1)];
      const block = hit && document.querySelector(".page")?.children[hit.block];
      const inBlock = block ? domMatches.filter((range) => block.contains(range.startContainer)) : [];
      current = hit && inBlock[Math.min(hit.ordinal, inBlock.length - 1)];
      const key = `${q}\0${idx}`;
      scrollToCurrent = !!current && revealed !== key;
      if (current) revealed = key;
      // Not rendered yet: bring its block near, and this effect runs again.
      else if (block && revealed !== key) block.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
    }
    if (highlights && "Highlight" in window) {
      const H = (window as unknown as { Highlight: new (...r: Range[]) => unknown }).Highlight;
      highlights.set("sarala-find", new H(...domMatches));
      if (current) highlights.set("sarala-find-current", new H(current));
      else highlights.delete("sarala-find-current");
    }
    // Keep the current match in view without activating anything.
    if (current && scrollToCurrent) {
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
          <div class="findbar-search" classList={{ invalid: invalid() }}>
            <svg class="findbar-search-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={inputEl}
              aria-label="Find" placeholder="Find" aria-invalid={invalid()}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
            />
          </div>
          <div class="findbar-toggles">
            <button class="find-toggle" classList={{ on: caseSensitive() }}
              title="Match case" aria-label="Match case" aria-pressed={caseSensitive()} onClick={() => setCaseSensitive(!caseSensitive())}>Aa</button>
            <button class="find-toggle" classList={{ on: wholeWord() }}
              title="Whole word" aria-label="Whole word" aria-pressed={wholeWord()} onClick={() => setWholeWord(!wholeWord())}>W</button>
            <button class="find-toggle mono" classList={{ on: useRegex() }}
              title="Use regular expression" aria-label="Use regular expression" aria-pressed={useRegex()} onClick={() => setUseRegex(!useRegex())}>.*</button>
          </div>
          <span class="findbar-count" role="status">{count()}</span>
          <button class="ghost-btn" title="Previous (Shift+Enter)" aria-label="Previous match" onClick={() => findNext(-1)}>↑</button>
          <button class="ghost-btn" title="Next (Enter)" aria-label="Next match" onClick={() => findNext(1)}>↓</button>
          <button class="ghost-btn" title="Toggle replace" aria-label="Toggle replace" aria-expanded={withReplace()} onClick={() => setWithReplace(!withReplace())}>⇄</button>
          <button class="ghost-btn" title="Close (Esc)" aria-label="Close find" onClick={closeFind}>✕</button>
        </div>
        <Show when={withReplace()}>
          <div class="findbar-row">
            <input
              aria-label="Replace with" placeholder="Replace with"
              value={replaceWith()}
              onInput={(e) => setReplaceWith(e.currentTarget.value)}
              onKeyDown={(e) => e.key === "Escape" && closeFind()}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
            />
            <button class="ghost-btn" onClick={replaceCurrent}>Replace</button>
            <button class="ghost-btn" onClick={replaceAllMatches}>All</button>
          </div>
        </Show>
      </div>
    </Show>
  );
}
