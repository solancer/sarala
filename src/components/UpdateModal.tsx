import { Show, createSignal, onMount } from "solid-js";
import { isTauri } from "../platform";
import {
  availableUpdate,
  updatePhase,
  updateError,
  startInstall,
  dismissUpdate,
} from "../updater";

const FALLBACK_VERSION = "0.4.1";

/**
 * "Update available" modal. Opened by the updater (startup auto-check or the
 * Help menu) whenever a newer version is found; shows the version + release
 * notes, then a live download/install progress bar once the user opts in.
 */
export default function UpdateModal() {
  const [current, setCurrent] = createSignal(FALLBACK_VERSION);
  onMount(() => {
    if (isTauri) {
      void import("@tauri-apps/api/app").then(({ getVersion }) =>
        getVersion().then(setCurrent).catch(() => {}),
      );
    }
  });

  const phase = updatePhase;
  const busy = () => phase().kind === "downloading" || phase().kind === "installing";
  const determinate = () => phase().kind === "downloading";
  const percent = () => {
    const p = phase();
    return p.kind === "downloading" ? p.percent : 0;
  };

  return (
    <Show when={availableUpdate()}>
      {(u) => (
        <div
          class="about-backdrop"
          onMouseDown={(e) => e.target === e.currentTarget && !busy() && dismissUpdate()}
        >
          <div
            class="pandoc-dl"
            onKeyDown={(e) => e.key === "Escape" && !busy() && dismissUpdate()}
            tabindex="-1"
          >
            <div class="pandoc-dl-icon" classList={{ err: !!updateError() }}>
              <Show
                when={!updateError()}
                fallback={
                  <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
                    <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 8v5m0 3h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
                  </svg>
                }
              >
                <svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true">
                  <path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M12 3v10m0 0 3.5-3.5M12 13 8.5 9.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
                </svg>
              </Show>
            </div>

            <h2 class="pandoc-dl-title">
              {updateError() ? "Update failed" : "Update available"}
            </h2>

            <p class="pandoc-dl-text">
              <strong>Sarala {u().version}</strong> is available
              <Show when={current()}> — you have v{current()}</Show>.
            </p>

            <Show when={u().notes && !busy() && !updateError()}>
              <div class="update-notes">{u().notes}</div>
            </Show>

            <Show when={busy()}>
              <div class="pandoc-bar" classList={{ indet: !determinate() }}>
                <div
                  class="pandoc-bar-fill"
                  style={{ width: determinate() ? `${percent()}%` : undefined }}
                />
              </div>
              <p class="pandoc-dl-step">
                {phase().kind === "installing" ? "Installing… the app will restart" : "Downloading…"}
                <Show when={determinate()}> <span class="pandoc-dl-pct">{percent()}%</span></Show>
              </p>
            </Show>

            <Show when={updateError()}>
              <p class="pandoc-dl-text err">{updateError()}</p>
            </Show>

            <Show when={!busy()}>
              <div class="pandoc-dl-actions">
                <button class="pandoc-btn ghost" onClick={dismissUpdate}>Later</button>
                <button class="pandoc-btn primary" onClick={() => void startInstall()}>
                  {updateError() ? "Retry" : "Update now"}
                </button>
              </div>
            </Show>
          </div>
        </div>
      )}
    </Show>
  );
}
