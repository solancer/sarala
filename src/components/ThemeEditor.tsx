import ModalFrame from "./ModalFrame";
/**
 * Custom theme editor — sixteen base16 swatches plus scheme import/export.
 *
 * Editing a swatch or importing a scheme writes straight to `customScheme`,
 * which App re-derives into a `<style>` block, so the whole app restyles live.
 * That is the point of authoring in base16 rather than in Sarala's own tokens:
 * sixteen colour decisions with published roles, instead of ~26 semantic ones
 * that have to stay mutually consistent by hand.
 */

import { For, Show, createSignal } from "solid-js";
import {
  BASE16_ROLES, BASE16_SLOTS, DEFAULT_SCHEME, base16ToTokens, normHex,
  parseBase16, toBase16Yaml, type Base16Slot,
} from "../base16";
import { customScheme, setCustomScheme, setTheme, theme } from "../store";
import { saveCustomScheme, setSetting } from "../settings";
import { clipboardWriteText } from "../platform";

const [visible, setVisible] = createSignal(false);
export const isThemeEditorOpen = visible;
export function openThemeEditor() {
  setVisible(true);
}

export default function ThemeEditor() {
  const [paste, setPaste] = createSignal("");

  const [error, setError] = createSignal<string | null>(null);
  const [importing, setImporting] = createSignal(false);

  const scheme = () => customScheme() ?? DEFAULT_SCHEME;

  const commit = (next: Parameters<typeof setCustomScheme>[0]) => {
    setCustomScheme(next);
    void saveCustomScheme();
    // Editing implies wanting to see it — switch to the slot if not already on
    // it. The choice has to be persisted too, or a reload restores the scheme
    // while data-theme falls back to the previous theme and nothing applies.
    if (theme() !== "custom") {
      setTheme("custom");
      void setSetting("theme", "custom");
    }
  };

  const setSlot = (slot: Base16Slot, value: string) => {
    const s = scheme();
    commit({ ...s, palette: { ...s.palette, [slot]: normHex(value) } });
  };

  const doImport = () => {
    const { scheme: parsed, error: err } = parseBase16(paste());
    if (err || !parsed) { setError(err ?? "Could not read that scheme."); return; }
    setError(null);
    setPaste("");
    setImporting(false);
    commit(parsed);
  };

  return (
    <Show when={visible()}>
      {/* Deliberately no click-outside dismissal: this is a builder, not a
          transient popover. Edits apply live, so clicking into the document to
          judge a colour is expected — and would otherwise throw away the panel
          mid-edit. Escape and the close button are the ways out. */}
      <div class="settings-backdrop theme-editor-backdrop">
        <ModalFrame class="theme-editor" label="Custom theme" onClose={() => setVisible(false)}>
          <div class="settings-head">
            <span class="settings-title">Custom theme</span>
            <button class="ip-close" title="Close" onClick={() => setVisible(false)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          <p class="te-intro">
            Authored in <strong>base16</strong> — sixteen colours with fixed roles. Paste any
            published scheme, or edit the swatches directly.
          </p>

          <div class="te-row">
            <label class="te-field">
              <span class="ip-label">Name</span>
              <input
                class="ip-input"
                value={scheme().name}
                onChange={(e) => commit({ ...scheme(), name: e.currentTarget.value || "Custom" })}
              />
            </label>
            <label class="te-field te-variant">
              <span class="ip-label">Variant</span>
              <select
                class="ip-input ip-select"
                value={scheme().variant}
                onChange={(e) =>
                  commit({ ...scheme(), variant: e.currentTarget.value as "light" | "dark" })
                }
              >
                <option value="dark">dark</option>
                <option value="light">light</option>
              </select>
            </label>
          </div>

          <div class="te-swatches">
            <For each={BASE16_SLOTS}>
              {(slot) => (
                <label class="te-swatch" title={BASE16_ROLES[slot]}>
                  <input
                    type="color"
                    class="te-color"
                    value={scheme().palette[slot]}
                    onInput={(e) => setSlot(slot, e.currentTarget.value)}
                  />
                  <span class="te-slot">{slot}</span>
                  <span class="te-role">{BASE16_ROLES[slot]}</span>
                </label>
              )}
            </For>
          </div>

          {/* Live preview of what the derivation produces, so the effect of a
              swatch on the actual chrome is visible without applying it. */}
          <div class="te-preview" style={base16ToTokens(scheme())}>
            <div class="te-prev-chrome">
              <span class="te-prev-dot" />
              <span class="te-prev-name">{scheme().name}</span>
            </div>
            <div class="te-prev-body">
              <span class="te-prev-h">Heading</span>
              <span class="te-prev-p">Body text with a <span class="te-prev-link">link</span>.</span>
              <span class="te-prev-code">const x = 1;</span>
            </div>
          </div>

          <Show
            when={importing()}
            fallback={
              <div class="te-actions">
                <button class="ghost-btn" onClick={() => { setImporting(true); setError(null); }}>
                  Import scheme…
                </button>
                <button class="ghost-btn" onClick={() => void clipboardWriteText(toBase16Yaml(scheme()))}>
                  Copy as YAML
                </button>
                <Show when={customScheme()}>
                  <button
                    class="ghost-btn te-reset"
                    onClick={() => {
                      setCustomScheme(null);
                      void saveCustomScheme();
                      setTheme("sarala");
                      void setSetting("theme", "sarala");
                    }}
                  >
                    Reset
                  </button>
                </Show>
              </div>
            }
          >
            <div class="te-import">
              <textarea
                class="te-paste"
                autofocus
                spellcheck={false}
                placeholder={"Paste a base16 scheme (YAML or JSON)…\n\nname: \"Dracula\"\nvariant: dark\npalette:\n  base00: \"#282a36\"\n  …"}
                value={paste()}
                onInput={(e) => setPaste(e.currentTarget.value)}
              />
              <Show when={error()}>
                <p class="te-error">{error()}</p>
              </Show>
              <div class="te-actions">
                <button class="ghost-btn" onClick={doImport}>Apply</button>
                <button class="ghost-btn" onClick={() => { setImporting(false); setError(null); }}>
                  Cancel
                </button>
              </div>
            </div>
          </Show>
        </ModalFrame>
      </div>
    </Show>
  );
}
