/**
 * Notion-style edge "+" rails on the active table: a full-height strip at the
 * right edge appends a column, a full-width strip at the bottom appends a row.
 * Both are invisible until the pointer is over them — reveal is pure CSS
 * `:hover`, no JS hover tracking.
 *
 * The rails cannot live inside the table markup: the live table is spans inside
 * the contenteditable `.source`, and anything injected there would land in the
 * block's `textContent` and break the source-offset invariant that caret
 * save/restore depends on. So they render as a sibling overlay inside `.block`
 * (which is `position: relative`) and are aligned by measuring the `.md-table`
 * element's box against the block's.
 *
 * Measurement re-runs whenever the source changes (an append re-flows the
 * grid) and on any resize of the table or the window.
 */

import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { appendColumnToActiveTable, appendRowToActiveTable } from "../commands";

interface Box {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface Props {
  /** The block's source text — re-measure whenever it changes. */
  text: string;
}

export default function TableRails(props: Props) {
  let hostEl: HTMLDivElement | undefined;
  const [box, setBox] = createSignal<Box | null>(null);

  const measure = () => {
    const block = hostEl?.parentElement;
    const table = block?.querySelector<HTMLElement>(".source .md-table");
    if (!block || !table) {
      setBox(null);
      return;
    }
    const b = block.getBoundingClientRect();
    const t = table.getBoundingClientRect();
    if (!t.width || !t.height) {
      setBox(null);
      return;
    }
    setBox({ top: t.top - b.top, left: t.left - b.left, width: t.width, height: t.height });
  };

  const ro = new ResizeObserver(() => measure());
  window.addEventListener("resize", measure);
  onCleanup(() => {
    ro.disconnect();
    window.removeEventListener("resize", measure);
  });

  // Re-run on every source change: the block rebuilds `.source`'s innerHTML,
  // so the `.md-table` element is a *new* node each time and an observer held
  // over from the previous render would be watching a detached one. Measuring
  // waits a frame for the fresh grid to lay out.
  createEffect(
    on(
      () => props.text,
      () => {
        requestAnimationFrame(() => {
          ro.disconnect();
          const block = hostEl?.parentElement;
          const table = block?.querySelector<HTMLElement>(".source .md-table");
          // Column widths settle asynchronously (fonts, content), so the
          // observer — not this one measurement — is what keeps them glued.
          if (table) ro.observe(table);
          if (block) ro.observe(block);
          measure();
        });
      },
    ),
  );

  return (
    <div
      class="tbl-rails"
      ref={hostEl}
      contentEditable={false}
      // Keep the caret and the block's focus exactly where they were: the
      // append commands place the caret themselves.
      onMouseDown={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <Show when={box()}>
        {(b) => (
          <>
            <button
              class="tbl-rail tbl-rail-col"
              tabIndex={-1}
              aria-label="Add column"
              title="Add column"
              style={{
                left: `${b().left + b().width}px`,
                top: `${b().top}px`,
                height: `${b().height}px`,
              }}
              onClick={() => appendColumnToActiveTable()}
            >
              <Plus />
            </button>
            <button
              class="tbl-rail tbl-rail-row"
              tabIndex={-1}
              aria-label="Add row"
              title="Add row"
              style={{
                left: `${b().left}px`,
                top: `${b().top + b().height}px`,
                width: `${b().width}px`,
              }}
              onClick={() => appendRowToActiveTable()}
            >
              <Plus />
            </button>
          </>
        )}
      </Show>
    </div>
  );
}

function Plus() {
  return (
    <svg
      class="tbl-rail-ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      aria-hidden="true"
    >
      <path d="M5 12h14M12 5v14" />
    </svg>
  );
}
