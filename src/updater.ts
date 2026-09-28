import { createSignal } from "solid-js";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri, isFlatpak, isMac, alertDialog, relaunchApp } from "./platform";

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
 * Browser-mode (`pnpm dev`) has no updater: the manual entry just says so. The
 * Flatpak build (isFlatpak) also opts out — Flathub delivers its own updates.
 */
export type UpdatePhase =
  | { kind: "idle" }
  | { kind: "checking" }
  /** `total` is 0 when the size is unknown (then `percent` is meaningless). */
  | { kind: "downloading"; percent: number; received: number; total: number }
  | { kind: "installing" };

/** "12.4 MB" (one decimal below 100 MB). */
export function formatMegabytes(bytes: number): string {
  const mb = bytes / 1_000_000;
  return `${mb < 100 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

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

/** Give up on a stalled check rather than leaving it outstanding forever. */
const CHECK_TIMEOUT_MS = 15_000;

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
  // Flathub owns updates for the Flatpak build: the binary is read-only, so the
  // updater can't replace it. Skip the startup check silently; tell a user who
  // explicitly asks where updates come from.
  if (isFlatpak) {
    if (!silent) {
      await alertDialog(
        "Sarala was installed via Flathub — updates are delivered through your software center.",
        "Update",
      );
    }
    return;
  }
  // Don't stack a check on top of a running check/download, or re-prompt while
  // the modal is already showing an available update.
  if (inFlight || availableUpdate() || updatePhase().kind !== "idle") return;
  inFlight = true;
  // A silent startup check deliberately shows nothing. It is background work
  // the user did not ask for, and surfacing it put "Checking for updates…" in
  // the status bar for the whole round trip — which the release endpoint can
  // easily make several seconds. Progress is shown only when the user asked
  // (Help ▸ Check for Updates…), and for downloads/installs they opted into.
  if (!silent) setUpdatePhase({ kind: "checking" });
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    // Bounded: without a timeout a stalled request never settles, so the
    // `finally` below never runs and the phase stays pinned forever.
    const update = await check({ timeout: CHECK_TIMEOUT_MS });
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

/**
 * Expected download size from the manifest (`size`, added by the release
 * workflow), used when the server omits Content-Length. The updater picks the
 * entry for this OS and install type, which the page can't see, so a size is
 * trusted only when every entry for this OS agrees (always true on macOS,
 * whose universal bundle serves both architectures).
 */
function manifestSize(update: Update): number {
  const platforms = (update.rawJson?.platforms ?? {}) as Record<string, { size?: unknown }>;
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const prefix = isMac ? "darwin-" : /Windows/i.test(ua) ? "windows-" : "linux-";
  const sizes = new Set(Object.entries(platforms)
    .filter(([key]) => key.startsWith(prefix))
    .map(([, entry]) => Number(entry?.size)));
  const [size] = sizes;
  return sizes.size === 1 && Number.isFinite(size) && size > 0 ? size : 0;
}

/** Download + install the pending update, then relaunch. Drives `updatePhase`
 *  for the modal/StatusBar; on failure records the message and reopens for a
 *  Retry. Invoked by the modal's "Update now" button. */
export async function startInstall(): Promise<void> {
  if (!pending || inFlight) return;
  inFlight = true;
  setUpdateError("");

  const fallbackTotal = manifestSize(pending);
  let total = fallbackTotal;
  let received = 0;
  let shown = -1;
  setUpdatePhase({ kind: "downloading", percent: 0, received: 0, total });
  try {
    await pending.downloadAndInstall((event) => {
      switch (event.event) {
        case "Started":
          // Without Content-Length the bar used to sit at 0% for the whole
          // download; fall back to the manifest size, else show bytes only.
          total = event.data.contentLength || fallbackTotal;
          received = 0;
          break;
        case "Progress": {
          received += event.data.chunkLength;
          // Never claim 100% before the download actually finishes.
          const percent = total ? Math.min(99, Math.floor((received / total) * 100)) : 0;
          // One UI update per visible change (percent, or each 0.1 MB when the
          // size is unknown), not one per network chunk.
          const step = total ? percent : Math.floor(received / 100_000);
          if (step === shown) break;
          shown = step;
          setUpdatePhase({ kind: "downloading", percent, received, total });
          break;
        }
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
