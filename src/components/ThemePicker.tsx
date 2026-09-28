import ModalFrame from "./ModalFrame";
/**
 * Themes gallery — the visual theme picker.
 *
 * Each card renders a miniature of the app's own chrome (topbar, sidebar with
 * dots, content lines) inside an element carrying `data-theme={id}`. Because
 * the curated palettes are plain `[data-theme="…"]` attribute rules, those
 * variables cascade straight into the card — so a preview is *literally* drawn
 * with the theme's real tokens and can never drift from it. No parallel table
 * of preview colours to maintain.
 *
 * The light/dark badge is measured, not declared: the card's own computed
 * `--bg-page` is run through the same relative-luminance function base16 uses
 * to infer a scheme's variant. Adding a theme to `THEMES` is therefore the only
 * step needed for it to appear here, correctly labelled.
 */

import { For, Show, createEffect, createSignal, on } from "solid-js";
import { THEMES, customScheme, theme, type ThemeId } from "../store";
import { executeCommand } from "../commands";
import { luminance } from "../base16";
import { openThemeEditor } from "./ThemeEditor";

const LABELS: Record<string, string> = {
  sarala: "Sarala", pro: "Pro", octagon: "Octagon", machine: "Machine",
  ristretto: "Ristretto", spectrum: "Spectrum", classic: "Classic",
  paper: "Paper", graphite: "Graphite", github: "GitHub", night: "Night",
  newsprint: "Newsprint", whitey: "Whitey", custom: "Custom",
};

const [visible, setVisible] = createSignal(false);
export const isThemePickerOpen = visible;
export function openThemePicker() {
  setVisible(true);
}

export default function ThemePicker() {
  // Measured per card once mounted, keyed by theme id.
  const [modes, setModes] = createSignal<Record<string, "light" | "dark">>({});
  let gridEl: HTMLDivElement | undefined;

  const measure = () => {
    if (!gridEl) return;
    const next: Record<string, "light" | "dark"> = {};
    for (const card of gridEl.querySelectorAll<HTMLElement>("[data-theme]")) {
      const id = card.dataset.theme;
      if (!id) continue;
      const bg = getComputedStyle(card).getPropertyValue("--bg-page").trim();
      if (bg) next[id] = luminance(bg) < 0.35 ? "dark" : "light";
    }
    setModes(next);
  };

  // Measure when the gallery opens, not on component mount: this lives in App
  // and mounts at startup, when the grid is not rendered and there is nothing
  // whose computed styles could be read.
  createEffect(
    on(visible, (v) => {
      if (v) requestAnimationFrame(measure);
    }),
  );

  /** Drill into the editor, closing the gallery behind us. Leaving it open
   *  stacked two modals that share a backdrop z-index, and the gallery — being
   *  mounted later in App — painted on top of the editor. */
  const editCustom = () => {
    setVisible(false);
    openThemeEditor();
  };

  const choose = (id: ThemeId) => {
    // An unconfigured Custom slot has nothing to apply — send them to the editor.
    if (id === "custom" && !customScheme()) { editCustom(); return; }
    executeCommand(`themes.set.${id}`);
  };

  const label = (id: string) =>
    id === "custom" && customScheme() ? customScheme()!.name : (LABELS[id] ?? id);

  return (
    <Show when={visible()}>
      <div
        class="settings-backdrop"
        onMouseDown={(e) => e.target === e.currentTarget && setVisible(false)}
      >
        <ModalFrame class="theme-picker" label="Themes" onClose={() => setVisible(false)}>
          <div class="settings-head">
            <span class="settings-title">Themes</span>
            <button class="ip-close" title="Close" onClick={() => setVisible(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
          <p class="te-intro">
            Pick a built-in palette, or build your own from a base16 scheme.
          </p>

          <div class="tp-grid" ref={gridEl} role="radiogroup" aria-label="Themes">
            <For each={THEMES}>
              {(id) => (
                <div class="tp-cell">
                  <button
                    class="tp-card"
                    classList={{ on: theme() === id, unset: id === "custom" && !customScheme() }}
                    role="radio"
                    tabIndex={theme() === id ? 0 : -1}
                    onKeyDown={(e) => {
                      const step = ["ArrowRight", "ArrowDown"].includes(e.key) ? 1 : ["ArrowLeft", "ArrowUp"].includes(e.key) ? -1 : 0;
                      if (!step) return;
                      e.preventDefault();
                      const index = THEMES.indexOf(id);
                      const next = (index + step + THEMES.length) % THEMES.length;
                      gridEl?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
                      choose(THEMES[next]);
                    }}
                    aria-checked={theme() === id}
                    aria-label={label(id)}
                    onClick={() => choose(id)}
                  >
                    {/* The preview inherits this theme's variables by attribute. */}
                    <span class="tp-prev" data-theme={id}>
                      <span class="tp-prev-top">
                        <span class="tp-prev-pill" />
                      </span>
                      <span class="tp-prev-body">
                        <span class="tp-prev-side">
                          <span class="tp-prev-dot a" />
                          <span class="tp-prev-dot b" />
                          <span class="tp-prev-dot c" />
                        </span>
                        <span class="tp-prev-main">
                          <span class="tp-prev-line accent" />
                          <span class="tp-prev-line" />
                          <span class="tp-prev-line link" />
                        </span>
                      </span>
                    </span>
                    {/* An empty Custom slot is a call to action, not a palette
                        you can select — say so on the card itself. */}
                    <Show when={id === "custom" && !customScheme()}>
                      <span class="tp-setup">Set up…</span>
                    </Show>
                  </button>
                  <div class="tp-meta">
                    <span class="tp-name">
                      {label(id)}
                      <Show when={id === "custom" && !customScheme()}>
                        <span class="tp-unset"> — not set</span>
                      </Show>
                    </span>
                    <Show
                      when={id !== "custom"}
                      fallback={
                        <button class="tp-edit" onClick={editCustom}>Edit</button>
                      }
                    >
                      <span class="tp-mode">{modes()[id] ?? ""}</span>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
        </ModalFrame>
      </div>
    </Show>
  );
}
