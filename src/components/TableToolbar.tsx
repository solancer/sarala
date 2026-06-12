import { For, Show, createMemo, createSignal } from "solid-js";
import { tableDims } from "../tabletools";
import { executeCommand, resizeActiveTable, toggleTableFullWidth } from "../commands";
import { tableFullWidth } from "../store";

interface Props {
  text: string;
}

const GRID_COLS = 8;
const GRID_ROWS = 10;

/**
 * Typora-style floating toolbar above an active table block: grid-resize
 * picker (with exact cols x rows inputs), per-column alignment, delete.
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
      <div class="tt-group">
        <button
          class="tt-btn"
          title="Resize table"
          classList={{ on: pickerOpen() }}
          onClick={() => setPickerOpen(!pickerOpen())}
        >
          <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 2h5v5H2zM9 2h5v5H9zM2 9h5v5H2zM9 9h5v5H9z" opacity=".75"/></svg>
        </button>
        <button class="tt-btn" title="Align column left" onClick={() => executeCommand("paragraph.table.align_left")}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 3h12v1.6H2zM2 7.2h8v1.6H2zM2 11.4h12v1.6H2z"/></svg>
        </button>
        <button class="tt-btn" title="Align column center" onClick={() => executeCommand("paragraph.table.align_center")}>
          <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M2 3h12v1.6H2zM4 7.2h8v1.6H4zM2 11.4h12v1.6H2z"/></svg>
        </button>
        <button class="tt-btn" title="Align column right" onClick={() => executeCommand("paragraph.table.align_right")}>
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
      </div>
      <button class="tt-btn tt-delete" title="Delete table" onClick={() => executeCommand("edit.delete_block")}>
        <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M6 2h4v1h4v1.5H2V3h4zM3.5 5.5h9L11.8 14H4.2zM6.2 7l.3 5h1.2l-.3-5zm3.4 0-.3 5h1.2l.3-5z"/></svg>
      </button>

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
