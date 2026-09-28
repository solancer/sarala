import { For, Show, createMemo, createSignal } from "solid-js";
import { tableDims, parseTable, columnAtOffset, lineAtOffset } from "../tabletools";
import { executeCommand, resizeActiveTable, toggleTableFullWidth } from "../commands";
import { tableFullWidth, liveCaretOffset } from "../store";

interface Props {
  text: string;
}

const GRID_COLS = 8;
const GRID_ROWS = 10;

/** Icons for moving the caret's row/column: a bar for the row or column being
 *  moved, and an arrow for the direction, so it reads as "move this row up". */
const MOVE_ICONS: Record<string, string> = {
  move_row_up: "M2 11.5h12V14H2zM8 1.5 11.5 5H9v4.5H7V5H4.5z",
  move_row_down: "M2 2h12v2.5H2zM8 14.5 4.5 11H7V6.5h2V11h2.5z",
  move_col_left: "M11.5 2H14v12h-2.5zM1.5 8 5 4.5V7h4.5v2H5v2.5z",
  move_col_right: "M2 2h2.5v12H2zM14.5 8 11 11.5V9H6.5V7H11V4.5z",
};

/**
 * Toolbar above an active table: one compact bar with the table grid (resize
 * picker with exact cols x rows inputs), per-column alignment and width, row and
 * column moves for the caret's cell, then delete.
 * mousedown is swallowed everywhere except the inputs so the block's
 * contenteditable keeps focus and the caret column stays meaningful.
 */
export default function TableToolbar(props: Props) {
  const dims = createMemo(() => tableDims(props.text) ?? { rows: 2, cols: 2 });
  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [hover, setHover] = createSignal<{ rows: number; cols: number } | null>(null);
  const [inputRows, setInputRows] = createSignal<number | null>(null);
  const [inputCols, setInputCols] = createSignal<number | null>(null);

  const shown = () => hover() ?? { rows: inputRows() ?? dims().rows, cols: inputCols() ?? dims().cols };

  // Alignment of the column the caret sits in, so its toolbar button lights up.
  // A column with no explicit `:` markers is left-aligned by default.
  const activeAlign = createMemo(() => {
    const t = parseTable(props.text);
    if (!t) return null;
    const col = Math.min(columnAtOffset(props.text, liveCaretOffset()), t.align.length - 1);
    return t.align[col] ?? "left";
  });

  // Where the caret is, so moves that would do nothing are disabled rather
  // than silently ignored. Row 0 is the header, which stays put.
  const moves = createMemo(() => {
    const t = parseTable(props.text);
    if (!t) return { up: false, down: false, left: false, right: false };
    const offset = liveCaretOffset();
    const row = Math.min(Math.max(0, lineAtOffset(props.text, offset) - 1), t.rows.length - 1);
    const col = Math.min(columnAtOffset(props.text, offset), t.align.length - 1);
    return { up: row >= 2, down: row >= 1 && row < t.rows.length - 1, left: col > 0, right: col < t.align.length - 1 };
  });
  const moveButtons = [
    ["move_row_up", "Move row up", "up"], ["move_row_down", "Move row down", "down"],
    ["move_col_left", "Move column left", "left"], ["move_col_right", "Move column right", "right"],
  ] as const;

  const apply = (rows: number, cols: number) => {
    setPickerOpen(false);
    setHover(null);
    setInputRows(null);
    setInputCols(null);
    resizeActiveTable(rows, cols);
  };

  return (
    <div
      class="table-toolbar"
      onMouseDown={(e) => {
        if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
      }}
    >
      <div class="tt-group" role="toolbar" aria-label="Table">
        <button
          class="tt-btn"
          title="Resize table"
          classList={{ on: pickerOpen() }}
          onClick={() => setPickerOpen(!pickerOpen())}
        >
          <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" opacity=".75"/></svg>
        </button>
        <span class="tt-sep" aria-hidden="true" />
        <button class="tt-btn" classList={{ on: activeAlign() === "left" }} title="Align column left" onClick={() => executeCommand("paragraph.table.align_left")}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 3h12v1.6H2zM2 7.2h8v1.6H2zM2 11.4h12v1.6H2z"/></svg>
        </button>
        <button class="tt-btn" classList={{ on: activeAlign() === "center" }} title="Align column center" onClick={() => executeCommand("paragraph.table.align_center")}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 3h12v1.6H2zM4 7.2h8v1.6H4zM2 11.4h12v1.6H2z"/></svg>
        </button>
        <button class="tt-btn" classList={{ on: activeAlign() === "right" }} title="Align column right" onClick={() => executeCommand("paragraph.table.align_right")}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 3h12v1.6H2zM6 7.2h8v1.6H6zM2 11.4h12v1.6H2z"/></svg>
        </button>
        <button
          class="tt-btn"
          title={tableFullWidth() ? "Default width" : "Full width"}
          classList={{ on: tableFullWidth() }}
          onClick={() => void toggleTableFullWidth()}
        >
          <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M1.5 2h1.5v12H1.5zM13 2h1.5v12H13zM5.9 4.9 2.8 8l3.1 3.1 1-1L5.6 8.7h4.8l-1.3 1.4 1 1L13.2 8l-3.1-3.1-1 1 1.3 1.4H5.6l1.3-1.4z"/></svg>
        </button>
        <span class="tt-sep" aria-hidden="true" />
        <For each={moveButtons}>{([id, label, dir]) => (
          <button class="tt-btn" title={label} aria-label={label} disabled={!moves()[dir]}
            onClick={() => executeCommand(`paragraph.table.${id}`)}>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d={MOVE_ICONS[id]} /></svg>
          </button>
        )}</For>
        <span class="tt-sep" aria-hidden="true" />
        <button class="tt-btn tt-delete" title="Delete table" aria-label="Delete table" onClick={() => executeCommand("edit.delete_block")}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M6 2h4v1h4v1.5H2V3h4zM3.5 5.5h9L11.8 14H4.2zM6.2 7l.3 5h1.2l-.3-5zm3.4 0-.3 5h1.2l.3-5z"/></svg>
        </button>
      </div>

      <Show when={pickerOpen()}>
        <div class="tt-popover" onMouseLeave={() => setHover(null)}>
          <div class="tt-grid">
            <For each={Array.from({ length: GRID_ROWS * GRID_COLS })}>
              {(_, i) => {
                const row = () => Math.floor(i() / GRID_COLS) + 1;
                const col = () => (i() % GRID_COLS) + 1;
                return (
                  <span
                    class="tt-cell"
                    classList={{
                      on: row() <= shown().rows && col() <= shown().cols,
                      now: row() <= dims().rows && col() <= dims().cols,
                    }}
                    onMouseEnter={() => setHover({ rows: Math.max(2, row()), cols: col() })}
                    onClick={() => apply(Math.max(2, row()), col())}
                  />
                );
              }}
            </For>
          </div>
          <div class="tt-size">
            <input
              type="number"
              min="1"
              max="16"
              value={shown().cols}
              onInput={(e) => setInputCols(Number(e.currentTarget.value) || null)}
              onKeyDown={(e) => e.key === "Enter" && apply(shown().rows, shown().cols)}
            />
            <span>×</span>
            <input
              type="number"
              min="2"
              max="64"
              value={shown().rows}
              onInput={(e) => setInputRows(Number(e.currentTarget.value) || null)}
              onKeyDown={(e) => e.key === "Enter" && apply(shown().rows, shown().cols)}
            />
            <button class="tt-btn tt-apply" onClick={() => apply(shown().rows, shown().cols)}>OK</button>
          </div>
        </div>
      </Show>
    </div>
  );
}
