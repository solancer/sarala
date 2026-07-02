import { Show, For, createSignal, createMemo } from "solid-js";
import { proseFont, setProseFont, monoFont, setMonoFont } from "../store";
import { listSystemFonts, applyProseFont, applyMonoFont } from "../fonts";
import { setSetting } from "../settings";

const [visible, setVisible] = createSignal(false);
const [families, setFamilies] = createSignal<string[]>([]);
const [loading, setLoading] = createSignal(false);
let loaded = false;

/** Whether the Fonts window is open (for the status-bar toggle's active state). */
export const isSettingsOpen = visible;

export function openSettings() {
  setVisible(true);
  if (!loaded) {
    loaded = true;
    setLoading(true);
    // Hold the loader for a perceptible minimum even when the (cached) font scan
    // returns instantly, and only reveal the list once both resolve — otherwise a
    // populated list would replace the spinner before the eye registers it.
    const minVisible = new Promise<void>((r) => setTimeout(r, 500));
    void Promise.all([listSystemFonts(), minVisible]).then(([fonts]) => {
      setFamilies(fonts);
      setLoading(false);
    });
  }
}

/**
 * Settings modal — currently the font picker. Lists the installed system fonts
 * (from Rust) for the editor prose font and the code font; selecting one swaps
 * the matching CSS variable live and persists it. Rows preview themselves in
 * their own family. Exports embed the chosen font, so they stay portable.
 */
export default function SettingsModal() {
  const [target, setTarget] = createSignal<"prose" | "mono">("prose");
  const [query, setQuery] = createSignal("");

  const current = () => (target() === "prose" ? proseFont() : monoFont());

  const filtered = createMemo(() => {
    const q = query().trim().toLowerCase();
    const list = families();
    return (q ? list.filter((f) => f.toLowerCase().includes(q)) : list).slice(0, 300);
  });

  const choose = async (family: string | null) => {
    if (target() === "prose") {
      setProseFont(family);
      applyProseFont(family);
      await setSetting("proseFont", family);
    } else {
      setMonoFont(family);
      applyMonoFont(family);
      await setSetting("monoFont", family);
    }
  };

  return (
    <Show when={visible()}>
      <div
        class="settings-backdrop"
        onMouseDown={(e) => e.target === e.currentTarget && setVisible(false)}
      >
        <div class="settings" onKeyDown={(e) => e.key === "Escape" && setVisible(false)} tabindex="-1">
          <div class="settings-head">
            <h2>Fonts</h2>
            <button class="ghost-btn primary" onClick={() => setVisible(false)}>Done</button>
          </div>

          <div class="settings-tabs">
            <button classList={{ on: target() === "prose" }} onClick={() => setTarget("prose")}>
              Editor font
            </button>
            <button classList={{ on: target() === "mono" }} onClick={() => setTarget("mono")}>
              Code font
            </button>
          </div>

          <div class="settings-current">
            <span>Current: <strong>{current() ?? "System default"}</strong></span>
            <button class="ghost-btn" disabled={!current()} onClick={() => void choose(null)}>
              Reset to default
            </button>
          </div>

          <input
            class="settings-search"
            placeholder="Search fonts…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
          />

          <div class="settings-list">
            <Show
              when={filtered().length}
              fallback={
                <Show
                  when={loading()}
                  fallback={
                    <div class="settings-empty">
                      {families().length ? "No matching fonts" : "No system fonts available"}
                    </div>
                  }
                >
                  <div class="settings-loading">
                    <span class="settings-spinner" aria-hidden="true" />
                    Loading fonts…
                  </div>
                </Show>
              }
            >
              <For each={filtered()}>
                {(f) => (
                  <button
                    class="settings-font"
                    classList={{ current: current() === f }}
                    style={{ "font-family": `"${f}"` }}
                    onClick={() => void choose(f)}
                  >
                    {f}
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
