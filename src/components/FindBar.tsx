import { Show, createSignal, createEffect } from "solid-js";
import { doc, setActive, updateBlock, requestSelection } from "../store";
import { getActiveBlockApi } from "../commands";

interface Match {
  blockIndex: number;
  start: number;
  end: number;
}

const [visible, setVisible] = createSignal(false);
const [withReplace, setWithReplace] = createSignal(false);
const [query, setQuery] = createSignal("");
const [replaceWith, setReplaceWith] = createSignal("");
const [cursor, setCursor] = createSignal(0);

let focusInput: (() => void) | undefined;

export function openFind(replace = false) {
  setWithReplace(replace);
  setVisible(true);
  queueMicrotask(() => focusInput?.());
}

export function closeFind() {
  setVisible(false);
}

// Plain function rather than createMemo: it runs at module scope (no root to
// own a computation), and reads of the reactive store still track in callers.
const matches = (): Match[] => {
  const q = query().toLowerCase();
  if (!visible() || !q) return [];
  const out: Match[] = [];
  doc.blocks.forEach((block, blockIndex) => {
    const text = block.text.toLowerCase();
    let from = 0;
    while (out.length < 999) {
      const at = text.indexOf(q, from);
      if (at === -1) break;
      out.push({ blockIndex, start: at, end: at + q.length });
      from = at + Math.max(q.length, 1);
    }
  });
  return out;
};

function jumpTo(match: Match) {
  if (doc.activeIndex === match.blockIndex) {
    getActiveBlockApi()?.selectRange(match.start, match.end);
  } else {
    requestSelection(match.start, match.end);
    setActive(match.blockIndex);
  }
}

export function findNext(dir: 1 | -1 = 1) {
  const all = matches();
  if (!all.length) return;
  const next = ((cursor() + dir) % all.length + all.length) % all.length;
  setCursor(next);
  jumpTo(all[next]);
}

function replaceCurrent() {
  const all = matches();
  if (!all.length) return;
  const i = Math.min(cursor(), all.length - 1);
  const m = all[i];
  const text = doc.blocks[m.blockIndex].text;
  updateBlock(m.blockIndex, text.slice(0, m.start) + replaceWith() + text.slice(m.end));
  // matches recompute from the edited doc; stay at the same slot, which now
  // holds the next occurrence.
  setCursor(i - 1);
  findNext();
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
    setCursor(-1);
  });

  const count = () => {
    const total = matches().length;
    if (!query()) return "";
    if (!total) return "0 results";
    return `${Math.min(cursor() + 1, total) || 1} of ${total}`;
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
