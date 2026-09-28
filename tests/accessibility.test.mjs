import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

let checks = 0;
const check = (actual, expected, label) => { assert.deepEqual(actual, expected, label); checks++; };
const dom = new JSDOM('<body><button id="trigger">Open</button><main id="background"><input></main><div id="overlay"><div id="modal" tabindex="-1"><input id="first"><button disabled>Disabled</button><button id="last">Close</button></div></div></body>', { pretendToBeVisual: true });
for (const name of ["window", "document", "HTMLElement", "Node", "KeyboardEvent"]) globalThis[name] = name === "window" ? dom.window : dom.window[name];
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
const out = fileURLToPath(new URL("./.build/modal-focus.mjs", import.meta.url));
await build({ entryPoints: [fileURLToPath(new URL("../src/modalFocus.ts", import.meta.url))], bundle: true, format: "esm", outfile: out });
const { containModalFocus } = await import(out);
const byId = (id) => document.getElementById(id);
const key = (el, key, shiftKey = false) => el.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true }));
byId("trigger").focus();
let closed = 0;
const release = containModalFocus(byId("modal"), () => closed++);
check(document.activeElement.id, "first", "dialog focuses first enabled control");
check(byId("background").inert, true, "background is inert");
key(byId("first"), "Tab", true);
check(document.activeElement.id, "last", "Shift+Tab wraps to last control");
key(byId("last"), "Tab");
check(document.activeElement.id, "first", "Tab wraps to first control");
let arrows = 0;
document.addEventListener("keydown", (e) => { if (e.key === "ArrowDown") arrows++; });
key(byId("first"), "ArrowDown");
check(arrows, 1, "combobox keys still reach delegated component handlers");
key(byId("first"), "Escape");
check(closed, 1, "Escape dismisses top dialog");
const nested = document.createElement("div");
nested.innerHTML = '<div id="nested" tabindex="-1"><button id="nested-close">Close nested</button></div>';
document.body.append(nested);
const releaseNested = containModalFocus(byId("nested"), () => {});
check(document.activeElement.id, "nested-close", "nested dialog receives focus");
check(byId("overlay").inert, true, "previous modal becomes inert");
releaseNested(); nested.remove();
check(document.activeElement.id, "first", "nested close restores previous dialog focus");
check(byId("background").inert, true, "background remains inert while parent stays open");
release();
check(document.activeElement.id, "trigger", "close restores invoking control");
check(!!byId("background").inert, false, "close restores background interaction");
byId("background").inert = true;
const releaseAgain = containModalFocus(byId("modal"), () => {});
releaseAgain();
check(byId("background").inert, true, "pre-existing inert state survives dialog lifetime");

// This checks opaque built-in color tokens, not composited/disabled text or custom themes.
const css = await readFile(new URL("../src/styles/app.css", import.meta.url), "utf8");
const luminance = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  .map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
  .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => { const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y); return (hi + .05) / (lo + .05); };
let themes = 0;
for (const [, theme, body] of css.matchAll(/\[data-theme="([^\"]+)"\]\s*\{([^}]+)/g)) {
  const tokens = Object.fromEntries([...body.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
  if (!tokens["--ink-soft"]) continue;
  themes++;
  for (const fg of ["--ink", "--ink-soft", "--accent"]) {
    for (const bg of ["--bg-panel", "--bg-page"]) {
      check(contrast(tokens[fg], tokens[bg]) >= 4.5, true, `${theme}: ${fg} on ${bg} meets 4.5:1`);
    }
  }
}
check(themes, 13, "all built-in palettes checked");
console.log(`${checks} accessibility checks passed`);
