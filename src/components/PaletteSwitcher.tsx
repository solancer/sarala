import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { theme, THEMES } from "../store";
import { executeCommand } from "../commands";

// One dot per theme — mirrors each theme's real signature --accent so the
// popover is an honest preview of what you get. Kept in sync with app.css.
export const DOTS: Record<string, string> = {
  sarala: "#c25a3c",    // terracotta
  pro: "#ab9df2",       // lavender
  octagon: "#ffd76d",   // gold
  machine: "#7cd5f1",   // sky blue
  ristretto: "#f38d70", // coral
  spectrum: "#7bd88f",  // green
  classic: "#f92672",   // iconic magenta
  paper: "#0e6a60",     // deep teal
  graphite: "#58bdb0",  // sea-glass
  github: "#4183c4",    // blue
  night: "#6cb2f7",     // sky blue
  newsprint: "#3f6079", // printer's-ink slate
  whitey: "#3a3f45",    // graphite (monochrome)
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
