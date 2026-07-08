import { createSignal } from "solid-js";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri, alertDialog, relaunchApp } from "./platform";

/**
 * Auto-updater flow. On launch the app silently checks the updater endpoint (a
 * gist serving latest.json) via `autoCheckForUpdates()`; when a newer version
 * exists, an in-app modal (UpdateModal) offers to download + install it. The
 * same modal backs the manual Help ▸ Check for Updates… entry, which — unlike
 * the startup check — also reports when you're already up to date.
 *
 * Download/install run through the JS updater plugin, publishing progress via
 * `updatePhase()` (shown both in the modal and the StatusBar), then ask Rust to
 * `app.restart()` so the new version takes effect.
 *
 * Browser-mode (`pnpm dev`) has no updater: the manual entry just says so.
 */
export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "downloading"; percent: number }
  | { kind: "installing" };

const [updatePhase, setUpdatePhase] = createSignal<UpdatePhase>({ kind: "idle" });
export { updatePhase };

export interface UpdateInfo {
  version: string;
  /** Release notes from the manifest; may be empty. */
  notes: string;
}

// When set, UpdateModal renders the "update available" prompt for this version.
const [availableUpdate, setAvailableUpdate] = createSignal<UpdateInfo | null>(null);
export { availableUpdate };

// Non-empty while the modal should show an install failure (keeps it open for a
// Retry). Cleared on each fresh attempt.
const [updateError, setUpdateError] = createSignal("");
export { updateError };

// The plugin's Update handle for the pending version; carries downloadAndInstall.
let pending: Update | null = null;
// Guards against overlapping checks/installs (menu re-click, startup race, …).
let inFlight = false;

/** Dismiss the update prompt ("Later"). No-op mid-download so we never orphan
 *  an install that's already writing to disk. */
export function dismissUpdate(): void {
  const kind = updatePhase().kind;
  if (kind === "downloading" || kind === "installing") return;
  setAvailableUpdate(null);
  setUpdateError("");
  pending = null;
}

/** Manual check (Help ▸ Check for Updates…): reports "up to date" and surfaces
 *  errors, since the user explicitly asked. */
export async function checkForUpdates(): Promise<void> {
  await runCheck(false);
}

/** Startup check: opens the modal only when an update exists, and stays silent
 *  otherwise (no "up to date" nag, no error dialog on a flaky network). */
export async function autoCheckForUpdates(): Promise<void> {
  await runCheck(true);
}

async function runCheck(silent: boolean): Promise<void> {
  if (!isTauri) {
    if (!silent) await alertDialog("Updates are only available in the desktop app.", "Update");
    return;
  }
  // Don't stack a check on top of a running check/download, or re-prompt while
  // the modal is already showing an available update.
  if (inFlight || availableUpdate() || updatePhase().kind !== "idle") return;
  inFlight = true;
  setUpdatePhase({ kind: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check();
    if (!update) {
      if (!silent) await alertDialog("You're up to date.", "Update");
      return;
    }
    pending = update;
    setUpdateError("");
    setAvailableUpdate({ version: update.version, notes: (update.body ?? "").trim() });
  } catch (err) {
    if (!silent) {
      await alertDialog(
        `Update check failed: ${err instanceof Error ? err.message : String(err)}`,
        "Update",
      );
    }
  } finally {
    inFlight = false;
    setUpdatePhase({ kind: "idle" });
  }
}

/** Download + install the pending update, then relaunch. Drives `updatePhase`
 *  for the modal/StatusBar; on failure records the message and reopens for a
 *  Retry. Invoked by the modal's "Update now" button. */
export async function startInstall(): Promise<void> {
  if (!pending || inFlight) return;
  inFlight = true;
  setUpdateError("");

  let total = 0;
  let received = 0;
  setUpdatePhase({ kind: "downloading", percent: 0 });
  try {
    await pending.downloadAndInstall((event) => {
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
    setUpdateError(err instanceof Error ? err.message : String(err));
    setUpdatePhase({ kind: "idle" });
    inFlight = false;
    // Modal stays open (availableUpdate still set) so the user can Retry.
  }
}
