import { Show, createSignal } from "solid-js";
import { insertTable } from "../commands";

const [visible, setVisible] = createSignal(false);

export function openTableDialog() {
  setVisible(true);
}

export default function TableDialog() {
  const [rows, setRows] = createSignal(3);
  const [cols, setCols] = createSignal(2);

  const close = () => setVisible(false);
  const submit = () => {
    close();
    insertTable(rows(), cols());
  };

  return (
    <Show when={visible()}>
      <div class="quick-open-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div class="table-dialog" onKeyDown={(e) => e.key === "Escape" && close()}>
          <h3>Insert Table</h3>
          <label>
            Rows
            <input
              type="number"
              min="1"
              max="64"
              value={rows()}
              onInput={(e) => setRows(Number(e.currentTarget.value) || 1)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>
          <label>
            Columns
            <input
              type="number"
              min="1"
              max="16"
              value={cols()}
              onInput={(e) => setCols(Number(e.currentTarget.value) || 1)}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </label>
          <div class="table-dialog-actions">
            <button class="ghost-btn" onClick={close}>Cancel</button>
            <button class="ghost-btn primary" onClick={submit}>Insert</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
