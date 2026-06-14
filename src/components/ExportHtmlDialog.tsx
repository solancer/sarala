import { Show, createSignal } from "solid-js";

const [visible, setVisible] = createSignal(false);
let resolver: ((v: boolean | null) => void) | null = null;

/**
 * Ask whether the HTML export should include the outline sidebar.
 * Resolves true (with outline), false (without), or null (cancelled).
 */
export function askHtmlOutline(): Promise<boolean | null> {
  setVisible(true);
  return new Promise((res) => {
    resolver = res;
  });
}

function choose(v: boolean | null) {
  setVisible(false);
  resolver?.(v);
  resolver = null;
}

export default function ExportHtmlDialog() {
  return (
    <Show when={visible()}>
      <div class="about-backdrop" onMouseDown={(e) => e.target === e.currentTarget && choose(null)}>
        <div class="export-dialog" onKeyDown={(e) => e.key === "Escape" && choose(null)} tabindex="-1">
          <h3>Export HTML</h3>
          <p>Include an outline sidebar (table of contents) in the exported page?</p>
          <div class="export-dialog-actions">
            <button class="ghost-btn" onClick={() => choose(null)}>Cancel</button>
            <button class="ghost-btn" onClick={() => choose(false)}>No outline</button>
            <button class="ghost-btn primary" onClick={() => choose(true)}>With outline</button>
          </div>
        </div>
      </div>
    </Show>
  );
}
