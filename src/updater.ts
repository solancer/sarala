import { createSignal } from "solid-js";
import { isTauri, confirmDialog, alertDialog, relaunchApp } from "./platform";

/**
 * Opt-in auto-updater flow (Help ▸ Check for Updates…). The whole sequence runs
 * in TypeScript via the JS updater plugin — check, prompt, download, install —
 * and then asks Rust to `app.restart()` so the new version takes effect. Progress
 * is published through `updatePhase()` and shown in the StatusBar.
 *
 * Browser-mode (`pnpm dev`) has no updater: the entry point just says so.
 */
export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; percent: number }
  | { kind: "installing" };

const [updatePhase, setUpdatePhase] = createSignal<UpdatePhase>({ kind: "idle" });
export { updatePhase };

// Guard against re-entry if the menu item is triggered while a check is running.
let inFlight = false;

export async function checkForUpdates(): Promise<void> {
  if (!isTauri) {
    await alertDialog("Updates are only available in the desktop app.", "Update");
    return;
  }
  if (inFlight) return;
  inFlight = true;
  setUpdatePhase({ kind: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();

    if (!update) {
      await alertDialog("You're up to date.", "Update");
      return;
    }

    const notes = update.body?.trim();
    const ok = await confirmDialog(
      `Sarala ${update.version} is available.` +
        (notes ? `\n\n${notes}` : "") +
        `\n\nDownload and install now? The app will restart when it's ready.`,
      "Update available",
    );
    if (!ok) return;

    // Stream the download into a percentage, then install.
    let total = 0;
    let received = 0;
    setUpdatePhase({ kind: "downloading", percent: 0 });
    await update.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          total = event.data.contentLength ?? 0;
          received = 0;
          break;
        case "Progress":
          received += event.data.chunkLength;
          setUpdatePhase({
            kind: "downloading",
            percent: total ? Math.round((received / total) * 100) : 0,
          });
          break;
        case "Finished":
          setUpdatePhase({ kind: "installing" });
          break;
      }
    });

    // Installed — relaunch into the new version (Rust app.restart()).
    await relaunchApp();
  } catch (err) {
    await alertDialog(
      `Update failed: ${err instanceof Error ? err.message : String(err)}`,
      "Update",
    );
  } finally {
    inFlight = false;
    setUpdatePhase({ kind: "idle" });
  }
}
