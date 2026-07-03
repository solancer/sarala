import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { theme, THEMES } from "../store";
import { executeCommand } from "../commands";

// A representative dot color per theme (a distinguishing hue).
export const DOTS: Record<string, string> = {
  sarala: "#e0566a",
  pro: "#ff6188",
  octagon: "#5b6ee1",
  machine: "#5ad4c4",
  ristretto: "#a8704f",
  spectrum: "#bbbbbb",
  classic: "#a6e22e",
  paper: "#0e6a60",
  graphite: "#58bdb0",
  github: "#4183c4",
  night: "#6cb2f7",
  newsprint: "#a4502f",
  whitey: "#2f6fed",
};

const [paletteVisible, setPaletteVisible] = createSignal(false);
export const isPaletteOpen = paletteVisible;
export function togglePalette() {
  setPaletteVisible((v) => !v);
}

/** Floating palette popover (toggled from the status bar): one dot per theme. */
export default function PaletteSwitcher() {
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest(".palette") && !t.closest(".palette-toggle")) setPaletteVisible(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setPaletteVisible(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onEsc);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onEsc);
    });
  });

  return (
    <Show when={paletteVisible()}>
      <div class="palette">
        <span class="palette-label">palette</span>
        <For each={THEMES}>
          {(id) => (
            <button
              class="palette-dot"
              classList={{ on: theme() === id }}
              title={id}
              style={{ background: DOTS[id] }}
              onClick={() => executeCommand(`themes.set.${id}`)}
            />
          )}
        </For>
      </div>
    </Show>
  );
}
