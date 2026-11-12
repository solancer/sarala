import assert from "node:assert/strict";
import { build } from "esbuild";

await build({
  entryPoints: ["src/omarchy.ts"], bundle: true, format: "esm",
  outfile: "tests/.build/omarchy.mjs",
});
const { parseOmarchyColors, omarchyToCss, followOmarchyTheme } =
  await import("./.build/omarchy.mjs");

const dark = `background = "#0c0b0c"
foreground = "#FAFCFB"
accent = "#b59790"
cyan = "#a5a0b6"
mode = "dark"`;
const light = `background = '#fafafa' # inline comment
foreground = '#101010'
color4 = '#0055aa'
color6 = '#007777'`;
let checks = 0;
function check(actual, expected, label) {
  assert.deepEqual(actual, expected, label);
  checks++;
}
const scheme = parseOmarchyColors(dark);
check(scheme.variant, "dark", "explicit dark variant");
check(scheme.palette.base00, "#0c0b0c", "background");
check(scheme.palette.base05, "#fafcfb", "normalised foreground");
check(scheme.palette.base0D, "#b59790", "system accent");
check(scheme.palette.base0C, "#a5a0b6", "links use cyan");
check(Object.keys(scheme.palette).length, 16, "complete base16 palette");
check(parseOmarchyColors(light).variant, "light", "infer light mode");
check(parseOmarchyColors(light).palette.base0D, "#0055aa", "numbered ANSI colours");
check(parseOmarchyColors(light).palette.base0C, "#007777", "numbered cyan");
check(parseOmarchyColors(dark.replace('mode = "dark"', "")).variant, "dark", "infer dark mode");
check(parseOmarchyColors(dark.replace('mode = "dark"', 'mode = "light"')).variant, "light", "explicit mode wins");
for (const text of ["", "background = '#123456'", "foreground = '#123456'", "background = 'red'\nforeground = '#ffffff'", "background = '#123456; color:red'\nforeground = '#ffffff'"]) {
  check(parseOmarchyColors(text), null, "ignore incomplete or unsafe palette");
}
check(parseOmarchyColors(`${dark}\n[other]\nbackground = '#ffffff'`).palette.base00, "#0c0b0c", "ignore table values");
check(parseOmarchyColors(dark.replace('accent = "#b59790"', 'accent = "#123456bad"')).palette.base0D, "#fafcfb", "invalid accent falls back");
check(omarchyToCss(scheme).includes('[data-theme="omarchy"]'), true, "CSS is scoped to Omarchy");
check(omarchyToCss(scheme).includes('[data-theme="custom"]'), false, "Custom is independent");
check(omarchyToCss(scheme).includes("color-scheme: dark"), true, "dark native controls");
check(omarchyToCss(scheme).includes("--shiki-dark"), true, "dark syntax highlighting");
check(omarchyToCss(parseOmarchyColors(light)).includes("--shiki-dark"), false, "light syntax highlighting");

// Deterministic timers: exercise polling and cancellation without sleeping.
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let nextTimer = 0;
globalThis.setTimeout = (callback) => { const id = ++nextTimer; timers.set(id, callback); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
const tick = async () => {
  const [id, callback] = timers.entries().next().value;
  timers.delete(id);
  callback();
  await flush();
};
try {
  let text = dark;
  let fail = false;
  const updates = [];
  const stop = followOmarchyTheme(async () => { if (fail) throw new Error("swap"); return text; }, (value) => updates.push(value));
  await flush();
  check(updates.length, 1, "initial palette");
  await tick();
  check(updates.length, 1, "unchanged palette causes no update");
  text = "";
  await tick();
  text = "invalid";
  await tick();
  fail = true;
  await tick();
  check(updates.length, 1, "keep last palette through missing, invalid and unreadable files");
  fail = false;
  text = light;
  await tick();
  check(updates.at(-1).variant, "light", "switch from dark to light");
  stop();
  check(timers.size, 0, "stop clears timer");
  let resolveRead;
  const late = [];
  const stopLate = followOmarchyTheme(() => new Promise((resolve) => { resolveRead = resolve; }), (value) => late.push(value));
  stopLate();
  resolveRead(dark);
  await flush();
  check(late.length, 0, "ignore in-flight response after stop");
  check(timers.size, 0, "stopped request cannot schedule another poll");
} finally {
  globalThis.setTimeout = originalSetTimeout;
  globalThis.clearTimeout = originalClearTimeout;
}
console.log(`${checks} Omarchy checks passed`);
