import ModalFrame from "./ModalFrame";
import { For, Show, createEffect, createSignal } from "solid-js";
import { insertTable } from "../commands";
import { parseTableDimension } from "../tabletools";

const [visible, setVisible] = createSignal(false);
export function openTableDialog() { setVisible(true); }

export default function TableDialog() {
  const [rows, setRows] = createSignal("3");
  const [cols, setCols] = createSignal("2");
  let rowsInput: HTMLInputElement | undefined;
  let colsInput: HTMLInputElement | undefined;
  const rowCount = () => parseTableDimension(rows(), 64);
  const colCount = () => parseTableDimension(cols(), 16);
  const valid = () => rowCount() !== null && colCount() !== null;
  const close = () => setVisible(false);
  createEffect(() => { if (visible()) { setRows("3"); setCols("2"); } });
  const submit = (e: SubmitEvent) => {
    e.preventDefault();
    const r = rowCount(), c = colCount();
    if (r === null || c === null) { (r === null ? rowsInput : colsInput)?.focus(); return; }
    close();
    insertTable(r, c);
  };

  return (
    <Show when={visible()}>
      <div class="table-dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <ModalFrame class="table-dialog" label="Insert table" onClose={close}>
          <form onSubmit={submit} noValidate>
            <div class="table-dialog-heading">
              <span class="table-dialog-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M3 14.5h18M10 9v11" />
                </svg>
              </span>
              <div><h2>Insert table</h2><p>Choose a size. You can add more cells later.</p></div>
            </div>
            <div class="table-dialog-fields">
              <label for="table-body-rows">Body rows
                <input ref={rowsInput} id="table-body-rows" type="number" min="1" max="64" step="1" required
                  value={rows()} aria-invalid={rowCount() === null} aria-describedby="table-rows-hint"
                  onFocus={(e) => e.currentTarget.select()} onInput={(e) => setRows(e.currentTarget.value)} />
                <span id="table-rows-hint" classList={{ invalid: rowCount() === null }}>
                  {rowCount() === null ? "Enter a whole number from 1 to 64." : "1–64 rows, plus a header"}
                </span>
              </label>
              <label for="table-columns">Columns
                <input ref={colsInput} id="table-columns" type="number" min="1" max="16" step="1" required
                  value={cols()} aria-invalid={colCount() === null} aria-describedby="table-cols-hint"
                  onFocus={(e) => e.currentTarget.select()} onInput={(e) => setCols(e.currentTarget.value)} />
                <span id="table-cols-hint" classList={{ invalid: colCount() === null }}>
                  {colCount() === null ? "Enter a whole number from 1 to 16." : "1–16 columns"}
                </span>
              </label>
            </div>
            <div class="table-dialog-preview">
              <div class="table-preview-grid" aria-hidden="true" style={{ "grid-template-columns": `repeat(${Math.min(colCount() ?? 2, 6)}, 1fr)` }}>
                <For each={Array.from({ length: (Math.min(rowCount() ?? 3, 4) + 1) * Math.min(colCount() ?? 2, 6) })}>
                  {(_, i) => <span classList={{ header: i() < Math.min(colCount() ?? 2, 6) }}><i /></span>}
                </For>
              </div>
              <p role="status">{valid()
                ? `${rowCount()} body ${rowCount() === 1 ? "row" : "rows"} × ${colCount()} ${colCount() === 1 ? "column" : "columns"} + header`
                : "Choose valid dimensions to insert a table."}</p>
              <Show when={valid() && (rowCount()! > 4 || colCount()! > 6)}><small>Preview shows the first 4 rows and 6 columns at most.</small></Show>
            </div>
            <div class="table-dialog-actions">
              <button type="button" class="table-cancel" onClick={close}>Cancel</button>
              <button type="submit" class="table-insert" disabled={!valid()}>Insert table</button>
            </div>
          </form>
        </ModalFrame>
      </div>
    </Show>
  );
}
