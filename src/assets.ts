/**
 * Rendering data that loads after startup: syntax grammars, the emoji catalog
 * and KaTeX. Keeping them out of the entry bundle roughly halves the script a
 * window parses before first paint. Loaders call `assetsReady()` when data
 * arrives; the store bumps `assetEpoch`, which re-renders only the blocks
 * whose render signature mentions it (code, math, emoji shortcodes).
 */
let listener: () => void = () => {};
export function onAssetsReady(fn: () => void) { listener = fn; }
export function assetsReady() { listener(); }

/** Run `fn` once the app is idle (after first paint), with a fallback timer. */
export function whenIdle(fn: () => void, timeout = 2000) {
  if (typeof window === "undefined") return;
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void }).requestIdleCallback;
  if (idle) idle(fn, { timeout });
  else setTimeout(fn, Math.min(timeout, 1000));
}
