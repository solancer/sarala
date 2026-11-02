/** Offline install and updates through the service worker. */
import { alertDialog, confirmDialog } from "../../src/platform";

let registration: ServiceWorkerRegistration | null = null;

export async function registerServiceWorker() {
  if (import.meta.env.DEV || !("serviceWorker" in navigator)) return;
  try {
    registration = await navigator.serviceWorker.register("./sw.js");
  } catch { /* still works online; private windows may refuse */ }
}

/** A new build waits until every tab of the old one has closed, unless asked. */
export async function checkForUpdates(silent: boolean): Promise<void> {
  if (!registration) {
    if (!silent) await alertDialog("The web version updates itself when you reload.", "Update");
    return;
  }
  await registration.update().catch(() => {});
  const waiting = registration.waiting ?? (await installed());
  if (!waiting) {
    if (!silent) await alertDialog("You're up to date.", "Update");
    return;
  }
  if (silent || !(await confirmDialog("A new version of Sarala is ready. Your open documents will be kept. Reload now?", "Update"))) return;
  navigator.serviceWorker.addEventListener("controllerchange", () => location.reload(), { once: true });
  waiting.postMessage("skip-waiting");
}

/** Wait for a worker that is mid-install, so the answer isn't "up to date". */
function installed(): Promise<ServiceWorker | null> {
  const worker = registration?.installing;
  if (!worker) return Promise.resolve(null);
  return new Promise((resolve) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") resolve(worker);
      else if (worker.state === "redundant") resolve(null);
    });
  });
}
