import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { emojiTriggerAt } from "../emojicompletion";
import { emojiMatches } from "../emoji";
import { getActiveBlockApi } from "../commands";
import { doc, requestCaret, updateBlock, emojiEnabled } from "../store";

/** Completion keeps focus and the selection in the editor, including with IME. */
export default function EmojiMenu() {
  const [trigger, setTrigger] = createSignal<{ block: number; start: number; end: number; query: string; x: number; y: number } | null>(null);
  const [active, setActive] = createSignal(0);
  const items = () => emojiMatches(trigger()?.query ?? "", 8);
  let composing = false;
  let dismissed = "";
  let editor: HTMLElement | null = null;
  const close = () => {
    setTrigger(null);
    editor?.removeAttribute("aria-controls");
    editor?.removeAttribute("aria-activedescendant");
    editor = null;
  };
  const syncActive = () => editor?.setAttribute("aria-activedescendant", `emoji-option-${active()}`);
  const update = () => {
    const selection = getActiveBlockApi()?.selectionOffsets();
    const block = doc.activeIndex;
    if (composing || !emojiEnabled() || block < 0 || !selection || selection.start !== selection.end) return close();
    const focused = document.activeElement?.matches(".source") ? document.activeElement as HTMLElement : null;
    if (!focused || focused.closest(".block-source-panel")) return close();
    if (editor && editor !== focused) close();
    const source = doc.blocks[block].text;
    const match = emojiTriggerAt(source, selection.start);
    if (!match || !emojiMatches(match.query).length) { dismissed = ""; return close(); }
    const key = `${doc.blocks[block].id}:${selection.start}:${match.query}`;
    if (dismissed === key) return close();
    dismissed = "";
    const range = window.getSelection()?.rangeCount ? window.getSelection()!.getRangeAt(0) : null;
    const rect = range?.getBoundingClientRect();
    editor = focused;
    if (!rect || !editor) return close();
    if (trigger()?.query !== match.query) setActive(0);
    setTrigger({ block, start: match.start, end: selection.start, query: match.query, x: Math.max(8, Math.min(rect.left, window.innerWidth - 290)), y: Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 330)) });
    editor.setAttribute("aria-controls", "emoji-completions");
    syncActive();
  };
  const choose = (name: string) => {
    const t = trigger();
    if (!t || t.block !== doc.activeIndex) return close();
    const text = doc.blocks[t.block].text;
    if (text.slice(t.start,t.end) !== `:${t.query}`) return close();
    const value = `:${name}:`;
    close();
    requestCaret(t.start + value.length);
    updateBlock(t.block, text.slice(0, t.start) + value + text.slice(t.end));
  };
  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      if (!trigger() || composing || event.isComposing) return;
      if (!editor || event.target !== editor || event.metaKey || event.ctrlKey || event.altKey || event.key === "Tab" && event.shiftKey) { close(); return; }
      if (!["ArrowDown", "ArrowUp", "Escape", "Enter", "Tab"].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const t = trigger()!;
      if (event.key === "Escape") { dismissed = `${doc.blocks[t.block]?.id}:${t.end}:${t.query}`; close(); }
      else if (event.key === "Enter" || event.key === "Tab") { const item = items()[active()]; if (item) choose(item.name); else close(); }
      else { setActive(i => (i + (event.key === "ArrowDown" ? 1 : -1) + items().length) % items().length); syncActive(); }
    };
    const input = () => requestAnimationFrame(update);
    const start = () => { composing = true; close(); };
    const end = () => { composing = false; input(); };
    const focus = () => { if (document.activeElement !== editor) close(); };
    const scroll = () => { if (trigger()) update(); };
    document.addEventListener("focusin", focus);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", scroll);
    document.addEventListener("selectionchange", update);
    document.addEventListener("input", input);
    document.addEventListener("keydown", keydown, true);
    document.addEventListener("compositionstart", start);
    document.addEventListener("compositionend", end);
    onCleanup(() => {
      close();
      document.removeEventListener("focusin", focus);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", scroll);
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("input", input);
      document.removeEventListener("keydown", keydown, true);
      document.removeEventListener("compositionstart", start);
      document.removeEventListener("compositionend", end);
    });
  });
  return <Show when={trigger()}>{t => <div id="emoji-completions" class="slash-menu emoji-menu" role="listbox" aria-label="Emoji suggestions" style={{ left: `${t().x}px`, top: `${t().y}px` }} onMouseDown={e => e.preventDefault()}>
    <For each={items()}>{(item, index) => <button id={`emoji-option-${index()}`} type="button" role="option" aria-selected={active() === index()} tabindex="-1" class="slash-item" classList={{ on: active() === index() }} onMouseEnter={() => { setActive(index()); syncActive(); }} onClick={() => choose(item.name)}><span aria-hidden="true">{item.glyph}</span><span>:{item.name}:</span></button>}</For>
  </div>}</Show>;
}
