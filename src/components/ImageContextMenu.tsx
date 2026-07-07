import { For, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
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
  // Position clamped into the viewport, and whether submenu flyouts must open
  // leftward (measured after mount so the raw click point can overflow an edge).
  const [place, setPlace] = createSignal<{ x: number; y: number; flip: boolean }>({ x: 0, y: 0, flip: false });
  let menuEl: HTMLDivElement | undefined;

  createEffect(() => {
    if (!target()) return;
    const { x, y } = pos();
    setPlace({ x, y, flip: false });
    // Measure once laid out, then nudge fully on-screen (before paint).
    queueMicrotask(() => {
      if (!menuEl) return;
      const r = menuEl.getBoundingClientRect();
      const m = 8; // viewport margin
      const nx = Math.max(m, Math.min(x, window.innerWidth - r.width - m));
      const ny = Math.max(m, Math.min(y, window.innerHeight - r.height - m));
      // Flip flyouts left when a ~210px submenu wouldn't fit to the right.
      const flip = nx + r.width + 210 > window.innerWidth - m;
      setPlace({ x: nx, y: ny, flip });
    });
  });

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
          classList={{ "im-flip": place().flip }}
          ref={menuEl}
          style={{ left: `${place().x}px`, top: `${place().y}px` }}
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
