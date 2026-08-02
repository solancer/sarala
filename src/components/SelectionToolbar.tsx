/**
 * Floating formatting bar over the current text selection.
 *
 * Anchored to the selection's client rect rather than to a block, so it tracks
 * the words the user actually highlighted. It only appears for a selection
 * that lives inside a single active block: cross-block selections are handled
 * by `blockselect.ts` (which keeps every block a plain rendered node, so there
 * is no source to format), and fenced code has no inline markup to toggle.
 *
 * Every control commits through `toggleInlineMark` / `setBlockKind`, which
 * restore the selection afterwards — the bar stays put across a run of clicks
 * the way it would in a document-model editor.
 */

import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { doc, targetBlockIndex } from "../store";
import { getActiveBlockApi, setBlockKind, toggleInlineMark } from "../commands";
import { activeMarks, type MarkKind } from "../inlineformat";
import { blockKind, type BlockKind } from "../blocktype";
import { selectedBlockRange } from "../blockselect";

const ICONS: Record<string, string> = {
  paragraph: '<path d="M13 4v16M17 4v16M19 4H9.5a4.5 4.5 0 0 0 0 9H13"/>',
  h1: '<path d="M4 12h8M4 18V6M12 18V6M17 12l3-2v8"/>',
  h2: '<path d="M4 12h8M4 18V6M12 18V6M21 18h-4c0-4 4-3 4-6 0-1.5-2-2.5-4-1"/>',
  h3: '<path d="M4 12h8M4 18V6M12 18V6M17.5 10.5c1.7-1 3.5 0 3.5 1.5a2 2 0 0 1-2 2 2 2 0 0 1 2 2c0 1.5-1.8 2.5-3.5 1.5"/>',
  bullet: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  ordered: '<path d="M10 6h11M10 12h11M10 18h11M4 6h1v4M4 10h2M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/>',
  task: '<path d="M13 5h8M13 12h8M13 19h8M3 17l2 2 4-4M3 7l2 2 4-4"/>',
  quote: '<path d="M17 6H3M21 12H8M21 18H8M3 12v6"/>',
  code: '<path d="M10 9.5 8 12l2 2.5M14 9.5l2 2.5-2 2.5"/><rect x="3" y="3" width="18" height="18" rx="2"/>',

  strong: '<path d="M6 4h8a4 4 0 0 1 0 8H6zM6 12h9a4 4 0 0 1 0 8H6z"/>',
  emphasis: '<path d="M19 4h-9M14 20H5M15 4L9 20"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4M4 20h16"/>',
  strike: '<path d="M16 4H9a3 3 0 0 0-2.83 4M14 12a4 4 0 0 1 0 8H6M4 12h16"/>',
  codespan: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  highlight: '<path d="m9 11-6 6v3h9l3-3M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4z"/>',
  link: '<path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  sup: '<path d="m4 19 8-8M4 11l8 8M21 9h-4c0-1.5.4-2 1.5-2.5S21 5.5 21 4.5c0-.9-.7-1.5-1.5-1.5S18 3.6 18 4.5"/>',
  sub: '<path d="m4 5 8 8M12 5l-8 8M20 19h-4c0-1.5.4-2 1.5-2.5S20 15.5 20 14.5c0-.9-.7-1.5-1.5-1.5S17 13.6 17 14.5"/>',
  chevron: '<path d="m6 9 6 6 6-6"/>',
};

function Icon(props: { name: string; class?: string }) {
  return (
    <svg
      class={props.class ?? "sel-ic"}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      ref={(el) => (el.innerHTML = ICONS[props.name] ?? "")}
    />
  );
}

/** Offered in the dropdown. H4–H6 are reachable from the Paragraph menu. */
const BLOCK_TYPES: { kind: BlockKind; label: string; icon: string }[] = [
  { kind: "paragraph", label: "Text", icon: "paragraph" },
  { kind: "h1", label: "Heading 1", icon: "h1" },
  { kind: "h2", label: "Heading 2", icon: "h2" },
  { kind: "h3", label: "Heading 3", icon: "h3" },
  { kind: "bullet", label: "Bullet List", icon: "bullet" },
  { kind: "ordered", label: "Ordered List", icon: "ordered" },
  { kind: "task", label: "Task List", icon: "task" },
  { kind: "quote", label: "Quote", icon: "quote" },
  { kind: "code", label: "Code Block", icon: "code" },
];

const HEADING_LABELS: Record<string, { label: string; icon: string }> = {
  h4: { label: "Heading 4", icon: "h3" },
  h5: { label: "Heading 5", icon: "h3" },
  h6: { label: "Heading 6", icon: "h3" },
};

const MARK_GROUPS: { kind: Exclude<MarkKind, "image">; title: string; icon: string }[][] = [
  [
    { kind: "strong", title: "Bold", icon: "strong" },
    { kind: "emphasis", title: "Italic", icon: "emphasis" },
    { kind: "underline", title: "Underline", icon: "underline" },
    { kind: "strike", title: "Strikethrough", icon: "strike" },
    { kind: "code", title: "Code", icon: "codespan" },
    { kind: "highlight", title: "Highlight", icon: "highlight" },
  ],
  [
    { kind: "link", title: "Link", icon: "link" },
    { kind: "sup", title: "Superscript", icon: "sup" },
    { kind: "sub", title: "Subscript", icon: "sub" },
  ],
];

/**
 * Height of the floating control strip (`.topfloat`). A selection near the top
 * of the document has no room above it without colliding with those controls,
 * so the bar flips below instead. Keep in step with `.topfloat`'s height.
 */
const TOP_LIMIT = 48;
const GAP = 8;

export default function SelectionToolbar() {
  let barEl: HTMLDivElement | undefined;
  const [rect, setRect] = createSignal<DOMRect | null>(null);
  const [range, setRange] = createSignal<{ start: number; end: number } | null>(null);
  const [menuOpen, setMenuOpen] = createSignal(false);

  const blockText = () => {
    const i = targetBlockIndex();
    return i >= 0 ? doc.blocks[i].text : "";
  };
  const marks = () => {
    const r = range();
    return r ? activeMarks(blockText(), r.start, r.end) : new Set<MarkKind>();
  };
  const kind = () => blockKind(blockText());
  const current = () =>
    BLOCK_TYPES.find((b) => b.kind === kind()) ??
    HEADING_LABELS[kind()] ??
    BLOCK_TYPES[0];

  const hide = () => {
    setRect(null);
    setRange(null);
    setMenuOpen(false);
  };

  const update = () => {
    const i = doc.activeIndex;
    if (i < 0) return hide();
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return hide();
    // Ignore selections the user made inside the bar's own inputs/menu.
    if (barEl?.contains(sel.anchorNode)) return;
    const blockEl = document.querySelectorAll(".editor .page > .block")[i];
    if (!blockEl || !blockEl.contains(sel.anchorNode) || !blockEl.contains(sel.focusNode)) {
      return hide();
    }
    if (selectedBlockRange()) return hide();
    const text = doc.blocks[i].text;
    // A fenced block is literal source — none of these controls apply to it.
    if (/^\s*(`{3,}|~{3,})/.test(text)) return hide();
    const offsets = getActiveBlockApi()?.selectionOffsets();
    if (!offsets || offsets.end <= offsets.start) return hide();
    if (!text.slice(offsets.start, offsets.end).trim()) return hide();
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (!r.width && !r.height) return hide();
    setRange({ start: offsets.start, end: offsets.end });
    setRect(r);
  };

  /** Clamp into the viewport, flipping below the selection near the top bar. */
  const place = () => {
    const r = rect();
    if (!r || !barEl) return;
    const w = barEl.offsetWidth;
    const h = barEl.offsetHeight;
    const left = Math.max(
      GAP,
      Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - GAP),
    );
    const above = r.top - h - GAP;
    barEl.style.left = `${left}px`;
    barEl.style.top = `${above < TOP_LIMIT ? r.bottom + GAP : above}px`;
  };

  createEffect(() => {
    rect();
    requestAnimationFrame(place);
  });

  // Re-derive after any document mutation: a toggle rewrites the block, which
  // re-renders it and moves the selection rect.
  createEffect(() => {
    void doc.blocks[doc.activeIndex]?.text;
    if (rect()) requestAnimationFrame(update);
  });

  onMount(() => {
    // Wait for the pointer to come up before showing the bar — otherwise it
    // appears mid-drag and jumps under the cursor on every mousemove.
    let dragging = false;
    const onDown = (e: MouseEvent) => {
      if (barEl?.contains(e.target as Node)) return;
      dragging = true;
      hide();
    };
    const onUp = () => {
      if (!dragging) return;
      dragging = false;
      requestAnimationFrame(update);
    };
    const onSelectionChange = () => {
      if (dragging || menuOpen()) return;
      update();
    };
    const onScroll = () => {
      if (!rect()) return;
      update();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && rect()) hide();
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("mouseup", onUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("mouseup", onUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    });
  });

  return (
    <Show when={rect()}>
      <div
        class="sel-bar"
        ref={barEl}
        contentEditable={false}
        // Never let a click here move the caret or blur the block — the
        // selection is the thing being formatted.
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        <div class="sel-type">
          <button
            class="sel-type-btn"
            classList={{ on: menuOpen() }}
            title="Block type"
            onClick={() => setMenuOpen(!menuOpen())}
          >
            <Icon name={current().icon} />
            <span class="sel-type-label">{current().label}</span>
            <Icon name="chevron" class="sel-ic sel-caret" />
          </button>
          <Show when={menuOpen()}>
            <div class="sel-menu">
              <For each={BLOCK_TYPES}>
                {(bt) => (
                  <button
                    class="sel-menu-item"
                    classList={{ on: bt.kind === kind() }}
                    onClick={() => {
                      setMenuOpen(false);
                      setBlockKind(bt.kind);
                    }}
                  >
                    <Icon name={bt.icon} />
                    <span>{bt.label}</span>
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
        <For each={MARK_GROUPS}>
          {(group) => (
            <>
              <span class="sel-sep" />
              <For each={group}>
                {(m) => (
                  <button
                    class="sel-btn"
                    classList={{ on: marks().has(m.kind) }}
                    title={m.title}
                    aria-label={m.title}
                    aria-pressed={marks().has(m.kind)}
                    onClick={() => toggleInlineMark(m.kind)}
                  >
                    <Icon name={m.icon} />
                  </button>
                )}
              </For>
            </>
          )}
        </For>
      </div>
    </Show>
  );
}
