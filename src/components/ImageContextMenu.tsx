import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import {
  openImageLocation, copyImageTo, renameMoveImage, deleteImageFile,
  setImageZoom, switchImageSyntax, type ImageTarget,
} from "../imageactions";

const [target, setTarget] = createSignal<ImageTarget | null>(null);
const [pos, setPos] = createSignal({ x: 0, y: 0 });

/** Open the image context menu at a screen position. */
export function openImageMenu(t: ImageTarget, x: number, y: number) {
  setTarget(t);
  setPos({ x, y });
}
export function closeImageMenu() {
  setTarget(null);
}

const ZOOMS = [25, 50, 75, 100, 150, 200];

export default function ImageContextMenu() {
  const [submenu, setSubmenu] = createSignal<"zoom" | "syntax" | null>(null);

  onMount(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".img-menu")) closeImageMenu();
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && closeImageMenu();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onEsc);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onEsc);
    });
  });

  // Snapshot the target BEFORE closing the menu — closing clears the signal.
  // eslint-disable-next-line solid/reactivity -- read at click time inside the handler
  const run = (fn: (t: ImageTarget) => void | Promise<void>) => () => {
    const tgt = target();
    closeImageMenu();
    if (tgt) void fn(tgt);
  };

  return (
    <Show when={target()}>
      {(t) => (
        <div
          class="img-menu"
          style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button class="im-item" onClick={run(openImageLocation)}>Open Image Location…</button>
          <button class="im-item" onClick={run(copyImageTo)}>Copy Image to…</button>
          <button class="im-item" onClick={run(renameMoveImage)}>Rename or Move Image to…</button>
          <div class="im-sep" />
          <div class="im-sub" onMouseEnter={() => setSubmenu("zoom")} onMouseLeave={() => setSubmenu(null)}>
            <button class="im-item im-parent">Zoom Image<span class="im-caret">›</span></button>
            <Show when={submenu() === "zoom"}>
              <div class="img-menu im-flyout">
                <For each={ZOOMS}>
                  {(z) => <button class="im-item" onClick={run((t) => setImageZoom(t, z))}>{z}%</button>}
                </For>
              </div>
            </Show>
          </div>
          <div class="im-sub" onMouseEnter={() => setSubmenu("syntax")} onMouseLeave={() => setSubmenu(null)}>
            <button class="im-item im-parent">Switch Image Syntax<span class="im-caret">›</span></button>
            <Show when={submenu() === "syntax"}>
              <div class="img-menu im-flyout">
                <button class="im-item" onClick={run((t) => switchImageSyntax(t, "md"))}>
                  <span class="im-check">{t().kind === "md" ? "✓" : ""}</span> Markdown ![alt](src)
                </button>
                <button class="im-item" onClick={run((t) => switchImageSyntax(t, "html"))}>
                  <span class="im-check">{t().kind === "html" ? "✓" : ""}</span> HTML &lt;img src="src" /&gt;
                </button>
              </div>
            </Show>
          </div>
          <div class="im-sep" />
          <button class="im-item im-danger" onClick={run(deleteImageFile)}>Delete Image File</button>
        </div>
      )}
    </Show>
  );
}
