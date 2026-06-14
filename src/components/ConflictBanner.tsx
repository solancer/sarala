import { Show, createMemo } from "solid-js";
import { doc, externalChange } from "../store";
import { reloadFromDisk, keepMine } from "../commands";

/**
 * Non-blocking bar shown when the Rust file watcher reports that the open file
 * changed (or was deleted) on disk by another program. The editor underneath
 * stays usable; the user resolves the conflict when ready.
 */
export default function ConflictBanner() {
  // Only surface a change that concerns the file this window has open.
  const active = createMemo(() => {
    const c = externalChange();
    return c && c.path === doc.filePath ? c : null;
  });

  return (
    <Show when={active()}>
      {(c) => (
        <div class="conflict-banner" classList={{ deleted: c().deleted }} role="alert">
          <span class="conflict-msg">
            <Show
              when={c().deleted}
              fallback={<>This file was changed on disk by another program.</>}
            >
              This file was deleted on disk.
            </Show>
          </span>
          <span class="conflict-actions">
            <Show when={!c().deleted}>
              <button class="conflict-btn primary" onClick={() => void reloadFromDisk()}>
                Reload
              </button>
            </Show>
            <button class="conflict-btn" onClick={() => void keepMine()}>
              Keep mine
            </button>
          </span>
        </div>
      )}
    </Show>
  );
}
