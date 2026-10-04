import { Show, createSignal, onCleanup, onMount } from "solid-js";
import { executeCommand, getActiveBlockApi, linkTargetAtCaret } from "../commands";
import { doc, requestCaret, setActive } from "../store";
import { attachMenuKeyboard, keyboardMenuPoint } from "../menuKeyboard";
import { aiEnabled } from "../ai/config";
import { isMac } from "../platform";

// Stroked 24×24 icon paths (Lucide-style), rendered via a ref so the static
// markup doesn't trip the solid/no-innerhtml lint rule.
const ICONS: Record<string, string> = {
  cut: '<circle cx="6" cy="6" r="3"/><path d="M8.12 8.12 12 12"/><path d="M20 4 8.12 15.88"/><circle cx="6" cy="18" r="3"/><path d="M14.8 14.8 20 20"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  paste: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  copyAs: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M8 11h8"/><path d="M8 16h5"/>',
  sparkle: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  table: '<path d="M12 3v18"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/>',
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
  /** Right-click landed inside a table block → show the Table submenu. */
  inTable: boolean;
  /** The caret is in a link → offer Open / Copy / Remove link. */
  link: boolean;
}

const [state, setState] = createSignal<MenuState | null>(null);

/** Open the editor context menu at a screen position, with the current selection. */
export function openEditorMenu(x: number, y: number, selection: string, inTable = false) {
  // Opened from the keyboard (Shift+F10 / Menu key): no pointer, so use the caret.
  if (x === 0 && y === 0) ({ x, y } = keyboardMenuPoint());
  setState({ x, y, selection, inTable, link: !!linkTargetAtCaret() });
}
export function closeEditorMenu() {
  setState(null);
}

export default function EditorContextMenu() {
  const [subOpen, setSubOpen] = createSignal(false);
  const [tableOpen, setTableOpen] = createSignal(false);

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
            class="ctx-menu" role="menu" aria-label="Edit"
            ref={(el) => {
              // Where to put the caret back if editing ended while the menu had focus.
              const index = doc.activeIndex;
              const caret = getActiveBlockApi()?.caretOffset() ?? null;
              onCleanup(attachMenuKeyboard(el, closeEditorMenu, () => {
                if (index < 0) return;
                if (caret !== null) requestCaret(caret);
                setActive(index);
              }));
            }}
            style={{ left: `${s().x}px`, top: `${s().y}px` }}
            onContextMenu={(e) => e.preventDefault()}
          >
            <button class="ctx-item" role="menuitem" tabIndex={-1} disabled={!sel()} onMouseDown={exec("cut")}>
              <Icon name="cut" /><span class="ctx-label">Cut</span>
            </button>
            <button class="ctx-item" role="menuitem" tabIndex={-1} disabled={!sel()} onMouseDown={exec("copy")}>
              <Icon name="copy" /><span class="ctx-label">Copy</span>
            </button>
            <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("edit.paste")}>
              <Icon name="paste" /><span class="ctx-label">Paste</span>
            </button>
            <div class="ctx-sub" onMouseEnter={() => setSubOpen(true)} onMouseLeave={() => setSubOpen(false)}>
              <button class="ctx-item ctx-parent" role="menuitem" aria-haspopup="menu" tabIndex={-1}>
                <Icon name="copyAs" /><span class="ctx-label">Copy / Paste As…</span><span class="ctx-caret">›</span>
              </button>
              <Show when={subOpen()}>
                <div class="ctx-menu ctx-flyout" role="menu">
                  <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("edit.copy_markdown")}><span class="ctx-label">Copy as Markdown</span></button>
                  <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("edit.copy_html")}><span class="ctx-label">Copy as HTML Code</span></button>
                  <button class="ctx-item" role="menuitem" tabIndex={-1} disabled><span class="ctx-label">Copy without Theme Styling</span></button>
                  <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("edit.copy_plain")}><span class="ctx-label">Copy as Plain Text</span></button>
                  <div class="ctx-sep" role="separator" />
                  <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("edit.paste_plain")}><span class="ctx-label">Paste as Plain Text</span></button>
                </div>
              </Show>
            </div>
            <Show when={s().link}>
              <div class="ctx-sep" role="separator" />
              <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("edit.open_link")}>
                <span class="ctx-ic" /><span class="ctx-label">Open Link</span><span class="ctx-kbd">{isMac ? "⌘↩" : "Ctrl+Enter"}</span>
              </button>
              <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("edit.copy_link")}>
                <span class="ctx-ic" /><span class="ctx-label">Copy Link Address</span>
              </button>
              <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("edit.remove_link")}>
                <span class="ctx-ic" /><span class="ctx-label">Remove Link</span>
              </button>
            </Show>
            <Show when={aiEnabled()}>
              <div class="ctx-sep" role="separator" />
              <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("ai.ask_selection")}>
                <Icon name="sparkle" /><span class="ctx-label">{sel() ? "Ask AI About Selection" : "Ask AI About This Block"}</span>
              </button>
              <button class="ctx-item" role="menuitem" tabIndex={-1} disabled={!sel()} onMouseDown={cmd("ai.improve")}>
                <span class="ctx-ic" /><span class="ctx-label">Improve Writing</span>
              </button>
              <button class="ctx-item" role="menuitem" tabIndex={-1} disabled={!sel()} onMouseDown={cmd("ai.fix_grammar")}>
                <span class="ctx-ic" /><span class="ctx-label">Fix Spelling &amp; Grammar</span>
              </button>
            </Show>
            <Show when={s().inTable}>
              <div class="ctx-sep" role="separator" />
              <div class="ctx-sub" onMouseEnter={() => setTableOpen(true)} onMouseLeave={() => setTableOpen(false)}>
                <button class="ctx-item ctx-parent" role="menuitem" aria-haspopup="menu" tabIndex={-1}>
                  <Icon name="table" /><span class="ctx-label">Table</span><span class="ctx-caret">›</span>
                </button>
                <Show when={tableOpen()}>
                  <div class="ctx-menu ctx-flyout" role="menu">
                    <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("paragraph.table.row_above")}><span class="ctx-label">Add Row Above</span></button>
                    <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("paragraph.table.row_below")}><span class="ctx-label">Add Row Below</span></button>
                    <div class="ctx-sep" role="separator" />
                    <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("paragraph.table.add_col_before")}><span class="ctx-label">Add Column Before</span></button>
                    <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("paragraph.table.add_col")}><span class="ctx-label">Add Column After</span></button>
                    <div class="ctx-sep" role="separator" />
                    <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("paragraph.table.delete_row")}><span class="ctx-label">Delete Row</span></button>
                    <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("paragraph.table.delete_col")}><span class="ctx-label">Delete Column</span></button>
                    <div class="ctx-sep" role="separator" />
                    <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("paragraph.table.copy")}><span class="ctx-label">Copy Table</span></button>
                    <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("paragraph.table.prettify")}><span class="ctx-label">Prettify Source Code</span></button>
                    <div class="ctx-sep" role="separator" />
                    <button class="ctx-item" role="menuitem" tabIndex={-1} onMouseDown={cmd("edit.delete_block")}><span class="ctx-label">Delete Table</span></button>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        );
      }}
    </Show>
  );
}
