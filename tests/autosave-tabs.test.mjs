import assert from "node:assert/strict";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
const shadows = new Map();
globalThis.__tabPlatform = {
  writeShadow: async (key, value) => { shadows.set(key, value); },
  clearShadow: async (key) => { shadows.delete(key); },
};
const out = fileURLToPath(new URL("./.build/autosave-tabs.mjs", import.meta.url));
await build({
  stdin: { contents: 'export * from "./src/store"; export * from "./src/autosave"; export { createRoot } from "solid-js";', resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
  bundle: true, format: "esm", conditions: ["browser"], outfile: out,
  plugins: [{ name: "storage-stub", setup(build) {
    build.onResolve({ filter: /^\.\/platform$/ }, () => ({ path: "platform", namespace: "stub" }));
    build.onResolve({ filter: /^\.\/settings$/ }, () => ({ path: "settings", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({ contents: path === "settings"
      ? 'export const addRecentFile = async () => {};'
      : 'export const {writeShadow, clearShadow} = globalThis.__tabPlatform; export const listShadows = async () => []; export const readFileEncoded = async () => ({content:""}); export const watchFile = async () => {};', loader: "js" }));
  } }],
});
const s = await import(out);
const originalInterval = globalThis.setInterval;
const originalClear = globalThis.clearInterval;
let tick;
globalThis.setInterval = (fn) => { tick = fn; return 1; };
globalThis.clearInterval = () => {};
const settle = () => new Promise((resolve) => setImmediate(resolve));
let dispose;
try {
  const a = s.openDocument("A", "/a.md"); s.updateBlock(0, "A edited");
  const b = s.openDocument("B", "/b.md"); s.updateBlock(0, "B edited");
  s.createRoot((stop) => { dispose = stop; s.startAutosave(); });
  tick(); await settle();
  assert.equal(shadows.get(s.keyForPath("/a.md")).content, "A edited\n", "inactive dirty document autosaves");
  assert.equal(shadows.get(s.keyForPath("/b.md")).content, "B edited\n", "active dirty document autosaves");
  s.openDocument("C", "/c.md"); await settle();
  assert.equal(shadows.size, 2, "switching to clean tab doesn't discard other shadows");
  s.markTabSaved(a, "/a.md", "A edited\n"); await settle();
  assert.equal(shadows.has(s.keyForPath("/a.md")), false, "saving inactive tab clears its shadow");
  assert.equal(shadows.has(s.keyForPath("/b.md")), true, "saving A preserves B recovery");
  s.removeTab(b); await settle();
  assert.equal(shadows.size, 0, "closing dirty tab clears its shadow");
  console.log("6 tab autosave checks passed");
} finally {
  dispose?.(); globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
  delete globalThis.__tabPlatform;
}
