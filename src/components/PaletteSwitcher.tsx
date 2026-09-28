import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { theme, THEMES, customScheme } from "../store";
import { executeCommand } from "../commands";
import { openThemeEditor } from "./ThemeEditor";
import { openThemePicker } from "./ThemePicker";

// One dot per theme — mirrors each theme's real signature --accent so the
// popover is an honest preview of what you get. Kept in sync with app.css.
export const DOTS: Record<string, string> = {
  sarala: "#8e422c",    // terracotta
  pro: "#ab9df2",       // lavender
  octagon: "#ffd76d",   // gold
  machine: "#7cd5f1",   // sky blue
  ristretto: "#f38d70", // coral
  spectrum: "#7bd88f",  // green
  classic: "#fb699e",   // iconic magenta
  paper: "#0e6a60",     // deep teal
  graphite: "#58bdb0",  // sea-glass
  github: "#3871a9",    // blue
  night: "#6cb2f7",     // sky blue
  newsprint: "#3f6079", // printer's-ink slate
  whitey: "#3a3f45",    // graphite (monochrome)
  // The Custom slot has no fixed signature — its dot follows the imported
  // scheme's accent (base0D), falling back to a neutral when none is set.
  custom: "#81a2be",
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
              class="palette-dot" aria-label={`Apply ${id} theme`} aria-pressed={theme() === id}
              classList={{ on: theme() === id, custom: id === "custom" }}
              title={id === "custom"
                ? `Custom${customScheme() ? ` — ${customScheme()!.name}` : " (click to set up)"}`
                : id}
              style={{
                background: id === "custom"
                  ? (customScheme()?.palette.base0D ?? DOTS.custom)
                  : DOTS[id],
              }}
              onClick={() => {
                // With no scheme yet there is nothing to switch to, so the dot
                // opens the editor instead of applying an empty theme.
                if (id === "custom" && !customScheme()) { openThemeEditor(); return; }
                executeCommand(`themes.set.${id}`);
              }}
              onDblClick={() => id === "custom" && openThemeEditor()}
            />
          )}
        </For>
        <button
          class="palette-more"
          title="All themes…"
          onClick={() => { setPaletteVisible(false); openThemePicker(); }}
        >
          All themes…
        </button>
      </div>
    </Show>
  );
}
