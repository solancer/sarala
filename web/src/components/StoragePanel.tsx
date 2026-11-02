import { For, Show, createResource, createSignal } from "solid-js";
import { backupLibrary, restoreLibrary } from "../backup";
import { confirmDialog, alertDialog } from "../../../src/platform";
import { clearLibrary, folders, unmount } from "../vfs";
import { pickWith } from "../pickers";

const mb = (bytes: number) => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(bytes / 1e6, 0.1).toFixed(1)} MB`);

/** Settings ▸ Storage: what is held here, how safe it is, and the way out. */
export default function StoragePanel() {
  const [estimate, { refetch }] = createResource(async () => ({
    usage: await navigator.storage?.estimate?.().catch(() => null),
    persisted: await navigator.storage?.persisted?.().catch(() => false),
  }));
  const [mounted, setMounted] = createSignal(folders());

  const restore = async () => {
    const file = await pickWith(".zip,application/zip");
    if (!file) return;
    try {
      await restoreLibrary(file);
      void refetch();
    } catch (error) {
      await alertDialog(`Could not restore that backup:\n${String(error)}`);
    }
  };
  const clear = async () => {
    if (await confirmDialog("Delete everything in the library? Back it up first. This cannot be undone.")) {
      await clearLibrary();
      void refetch();
    }
  };
  const protect = async () => {
    await navigator.storage?.persist?.().catch(() => false);
    void refetch();
  };

  return (
    <div class="web-storage">
      <Show when={estimate()?.usage}>
        {(u) => <p>{mb(u().usage ?? 0)} used of {mb(u().quota ?? 0)} available to this site.</p>}
      </Show>
      <p>
        {estimate()?.persisted
          ? "Protected: the browser won't clear this data to free up space."
          : "Not protected yet: under storage pressure, the browser may clear this data."}
      </p>
      <div class="web-storage-actions">
        <Show when={!estimate()?.persisted}><button class="ghost-btn" onClick={() => void protect()}>Protect</button></Show>
        <button class="ghost-btn" onClick={() => void backupLibrary()}>Back up library…</button>
        <button class="ghost-btn" onClick={() => void restore()}>Restore…</button>
        <button class="ghost-btn" onClick={() => void clear()}>Clear library…</button>
      </div>
      <Show when={mounted().length}>
        <h3>Folders on this device</h3>
        <ul>
          <For each={mounted()}>{(m) => (
            <li>
              <span>{m.name}</span>
              <button class="ghost-btn" onClick={() => void unmount(m).then(() => setMounted(folders()))}>Remove from Sarala</button>
            </li>
          )}</For>
        </ul>
      </Show>
    </div>
  );
}
