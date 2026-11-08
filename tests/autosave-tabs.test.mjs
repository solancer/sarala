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
globalThis.__tabShadows = shadows;
const out = fileURLToPath(new URL("./.build/autosave-tabs.mjs", import.meta.url));
await build({
  stdin: { contents: 'export * from "./src/store"; export * from "./src/autosave"; export { createRoot } from "solid-js";', resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
  bundle: true, format: "esm", conditions: ["browser"], outfile: out,
  plugins: [{ name: "storage-stub", setup(build) {
    build.onResolve({ filter: /^\.\/platform$/ }, () => ({ path: "platform", namespace: "stub" }));
    build.onResolve({ filter: /^\.\/settings$/ }, () => ({ path: "settings", namespace: "stub" }));
    build.onLoad({ filter: /.*/, namespace: "stub" }, ({ path }) => ({ contents: path === "settings"
      ? 'export const addRecentFile = async () => {};'
      : 'export const {writeShadow, clearShadow} = globalThis.__tabPlatform; export const listShadows = async () => [...globalThis.__tabShadows.values()]; export const readFileEncoded = async () => ({content:"on disk"}); export const watchFile = async () => {};', loader: "js" }));
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
  // Declining recovery keeps the work: the startup prompt skips it, opening
  // the file still offers it, and only old declined shadows are cleaned up.
  const session = { path: "/d.md", content: "unsaved work\n", savedAt: 1, encoding: "utf-8", hadBom: false };
  shadows.set(s.keyForPath("/d.md"), session);
  assert.equal((await s.findRecoverable()).length, 1, "an undeclined shadow is offered at startup");
  await s.declineShadows([session]);
  assert.equal(shadows.get(s.keyForPath("/d.md"))?.content, "unsaved work\n", "declining keeps the shadow");
  assert.equal((await s.findRecoverable()).length, 0, "a declined shadow isn't offered at startup again");
  assert.ok(await s.shadowFor("/d.md", "on disk"), "opening the file still offers a declined shadow");
  shadows.set(s.keyForPath("/d.md"), { ...session, declinedAt: Date.now() - 15 * 24 * 3600 * 1000 });
  await s.findRecoverable();
  assert.equal(shadows.has(s.keyForPath("/d.md")), false, "a shadow declined over two weeks ago is cleaned up");
  console.log("11 tab autosave checks passed");
} finally {
  dispose?.(); globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear;
  delete globalThis.__tabPlatform; delete globalThis.__tabShadows;
}
