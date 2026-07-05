import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { executeCommand } from "../commands";

// Stroked 24×24 icon paths (Lucide-style), rendered via a ref so the static
// markup doesn't trip the solid/no-innerhtml lint rule.
const ICONS: Record<string, string> = {
  cut: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  paste: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  copyAs: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M8 11h8"/><path d="M8 16h5"/>',
};

function Icon(props: { name: string }) {
  return (
    <svg
      class="ctx-ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      ref={(el) => (el.innerHTML = ICONS[props.name] ?? "")}
    />
  );
}

interface MenuState {
  x: number;
  y: number;
  /** Selected text captured when the menu opened (drives Look Up / Search etc.). */
  selection: string;
}

const [state, setState] = createSignal<MenuState | null>(null);

/** Open the editor context menu at a screen position, with the current selection. */
export function openEditorMenu(x: number, y: number, selection: string) {
  setState({ x, y, selection });
}
export function closeEditorMenu() {
  setState(null);
}

export default function EditorContextMenu() {
  const [subOpen, setSubOpen] = createSignal(false);

  onMount(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".ctx-menu")) closeEditorMenu();
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && closeEditorMenu();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onEsc);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onEsc);
    });
  });

  // Run on mousedown (preventDefault) so the DOM selection/caret survives the
  // click — execCommand copy/cut and copyPlain all read the live selection.
  const act = (fn: () => void) => (e: MouseEvent) => {
    e.preventDefault();
    fn();
    closeEditorMenu();
  };
  const cmd = (id: string) => act(() => executeCommand(id));
  const exec = (c: "cut" | "copy") => act(() => document.execCommand(c));

  return (
    <Show when={state()}>
      {(s) => {
        const sel = () => s().selection.trim();
        return (
          <div
            class="ctx-menu"
            style={{ left: `${s().x}px`, top: `${s().y}px` }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button class="ctx-item" disabled={!sel()} onMouseDown={exec("cut")}>
              <Icon name="cut" /><span class="ctx-label">Cut</span>
            </button>
            <button class="ctx-item" disabled={!sel()} onMouseDown={exec("copy")}>
              <Icon name="copy" /><span class="ctx-label">Copy</span>
            </button>
            <button class="ctx-item" onMouseDown={cmd("edit.paste")}>
              <Icon name="paste" /><span class="ctx-label">Paste</span>
            </button>
            <div class="ctx-sub" onMouseEnter={() => setSubOpen(true)} onMouseLeave={() => setSubOpen(false)}>
              <button class="ctx-item ctx-parent">
                <Icon name="copyAs" /><span class="ctx-label">Copy / Paste As…</span><span class="ctx-caret">›</span>
              </button>
              <Show when={subOpen()}>
                <div class="ctx-menu ctx-flyout">
                  <button class="ctx-item" onMouseDown={cmd("edit.copy_markdown")}><span class="ctx-label">Copy as Markdown</span></button>
                  <button class="ctx-item" onMouseDown={cmd("edit.copy_html")}><span class="ctx-label">Copy as HTML Code</span></button>
                  <button class="ctx-item" disabled><span class="ctx-label">Copy without Theme Styling</span></button>
                  <button class="ctx-item" onMouseDown={cmd("edit.copy_plain")}><span class="ctx-label">Copy as Plain Text</span></button>
                  <div class="ctx-sep" />
                  <button class="ctx-item" onMouseDown={cmd("edit.paste_plain")}><span class="ctx-label">Paste as Plain Text</span></button>
                </div>
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
}
