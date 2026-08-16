/**
 * Slash command menu — type `/` on a blank line to insert a block.
 *
 * Detection is derived, not intercepted: the menu watches the active block's
 * text and caret (the same signals the selection toolbar uses) and looks for a
 * `/query` token ending at the caret. Nothing hooks Block's key handling, so
 * typing, undo, and IME composition keep working exactly as before — the menu
 * simply opens and closes as the token appears and disappears.
 *
 * Running an item is two steps in one frame: delete the `/query` range, then
 * (after Solid has re-rendered the block and restored the caret) run the item's
 * command. The wait matters — the commands read the caret back out of the DOM,
 * which is still showing the pre-delete text until the next frame.
 */

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import { doc, targetBlockIndex } from "../store";
import { deleteRangeInBlock, getActiveBlockApi } from "../commands";
import { filterSlashItems, slashTriggerAt, type SlashItem, type SlashItemId } from "../slashmenu";
import { SLASH_ACTIONS } from "../slashactions";
import { parseTable } from "../tabletools";
import { ICONS } from "../menuicons";

/** Below the caret, unless that would run off the bottom of the window. */
const GAP = 6;
const MAX_H = 320;

export default function SlashMenu() {
  let menuEl: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [range, setRange] = createSignal<{ start: number; end: number } | null>(null);
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  const [active, setActive] = createSignal(0);

  const items = createMemo(() => filterSlashItems(query()));

  const close = () => {
    setOpen(false);
    setRange(null);
    setRect(null);
    setActive(0);
  };

  const update = () => {
    const i = doc.activeIndex;
    if (i < 0) return close();
    const text = doc.blocks[i].text;
    // Fenced code is literal, and a table block would be destroyed by a
    // block-converting item — same exclusions as the selection toolbar.
    if (/^\s*(`{3,}|~{3,})/.test(text) || parseTable(text)) return close();
    const api = getActiveBlockApi();
    const sel = api?.selectionOffsets();
    if (!sel || sel.end !== sel.start) return close();
    const trigger = slashTriggerAt(text, sel.start);
    if (!trigger) return close();

    const domSel = window.getSelection();
    if (!domSel || domSel.rangeCount === 0) return close();
    const r = domSel.getRangeAt(0).getBoundingClientRect();
    // A caret in an empty block can report a zero rect; fall back to the block.
    const blockEl = document.querySelectorAll(".editor .page > .block")[i];
    const anchor = r.height ? r : (blockEl?.getBoundingClientRect() ?? null);
    if (!anchor) return close();

    if (trigger.query !== query()) setActive(0);
    setQuery(trigger.query);
    setRange({ start: trigger.start, end: sel.start });
    setRect(anchor as DOMRect);
    setOpen(true);
  };

  /** Clamp into the viewport, flipping above the caret when it would overflow. */
  const place = () => {
    const r = rect();
    if (!r || !menuEl) return;
    const w = menuEl.offsetWidth;
    const h = menuEl.offsetHeight;
    const left = Math.max(GAP, Math.min(r.left, window.innerWidth - w - GAP));
    const below = r.bottom + GAP;
    const top = below + h > window.innerHeight - GAP ? Math.max(GAP, r.top - h - GAP) : below;
    menuEl.style.left = `${left}px`;
    menuEl.style.top = `${top}px`;
  };

  createEffect(() => {
    rect();
    items();
    requestAnimationFrame(place);
  });

  // Keep the highlighted row in view as the user arrows through a long list.
  createEffect(
    on(active, (i) => {
      menuEl?.querySelectorAll(".slash-item")[i]?.scrollIntoView({ block: "nearest" });
    }),
  );

  const run = (item: SlashItem) => {
    const r = range();
    close();
    if (r) deleteRangeInBlock(r.start, r.end);
    // The block re-renders and restores the caret on the next frame; the item's
    // command reads that caret, so it has to run after.
    requestAnimationFrame(() => SLASH_ACTIONS[item.id as SlashItemId]?.());
  };

  onMount(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!open()) return;
      const list = items();
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => (list.length ? (i + 1) % list.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => (list.length ? (i - 1 + list.length) % list.length : 0));
      } else if (e.key === "Enter" || e.key === "Tab") {
        const item = list[active()];
        if (!item) return; // no match — let Enter split the block as usual
        e.preventDefault();
        e.stopPropagation();
        run(item);
      }
    };
    // Capture: the active block's own keydown handler owns Enter and the
    // arrows, so the menu has to claim them first while it is open.
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("selectionchange", update);
    const onScroll = () => open() && update();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    onCleanup(() => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("selectionchange", update);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    });
  });

  // Typing does not always move the selection (replacing a selected range), so
  // track the block's text as well as selectionchange.
  createEffect(
    on(
      () => (targetBlockIndex() >= 0 ? doc.blocks[targetBlockIndex()]?.text : null),
      () => requestAnimationFrame(update),
      { defer: true },
    ),
  );

  return (
    <Show when={open() && items().length > 0}>
      <div
        class="slash-menu"
        ref={menuEl}
        style={{ "max-height": `${MAX_H}px` }}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <For each={items()}>
          {(item, i) => (
            <>
              <Show when={i() === 0 || items()[i() - 1].group !== item.group}>
                <div class="slash-group">{item.group}</div>
              </Show>
              <button
                class="slash-item"
                classList={{ on: i() === active() }}
                onMouseEnter={() => setActive(i())}
                onClick={() => run(item)}
              >
                <svg
                  class="slash-ic"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.7"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  aria-hidden="true"
                  ref={(el) => (el.innerHTML = ICONS[item.icon] ?? "")}
                />
                <span class="slash-label">{item.label}</span>
                <Show when={item.hint}>
                  <span class="slash-hint">{item.hint}</span>
                </Show>
              </button>
            </>
          )}
        </For>
      </div>
    </Show>
  );
}
