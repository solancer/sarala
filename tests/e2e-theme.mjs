/**
 * Live-app check of the base16 custom theme: real Vite dev server, real
 * Chromium, real cascade.
 *
 *   node tests/e2e-theme.mjs   (starts its own server on :1431)
 *
 * The unit tests cover parsing and derivation. This covers what only a live
 * document can: that the injected stylesheet actually wins over the curated
 * [data-theme] blocks, that editing a swatch restyles without a reload, and
 * that the 13 curated themes are untouched by any of it.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1431;
const server = spawn("npx", ["vite", "--port", String(PORT)], { stdio: "pipe" });
const kill = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", kill);

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("vite did not start")), 20000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); }
  });
  server.stderr.on("data", (d) => process.stderr.write(d));
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 860 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".app");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

const DRACULA = `system: base16
name: "Dracula"
variant: dark
palette:
  base00: "#282a36"
  base01: "#363447"
  base02: "#44475a"
  base03: "#6272a4"
  base04: "#9ea8c7"
  base05: "#f8f8f2"
  base06: "#f0f1f4"
  base07: "#ffffff"
  base08: "#ff5555"
  base09: "#ffb86c"
  base0A: "#f1fa8c"
  base0B: "#50fa7b"
  base0C: "#8be9fd"
  base0D: "#80bfff"
  base0E: "#ff79c6"
  base0F: "#bd93f9"
`;

const tokenOf = (name) =>
  page.evaluate(
    (n) => getComputedStyle(document.querySelector(".app")).getPropertyValue(n).trim(),
    name,
  );

// Baseline: the default curated theme.
const saralaInk = await tokenOf("--ink");
const saralaAccent = await tokenOf("--accent");
check(saralaAccent === "#8e422c", `curated theme active to start (accent ${saralaAccent})`);

// --- open the editor from the palette's Custom dot ---
await page.locator(".palette-toggle, .status-palette").first().click().catch(() => {});
if (!(await page.locator(".palette").isVisible().catch(() => false))) {
  // The palette is toggled from the status bar; fall back to opening directly.
  await page.evaluate(async () => {
    const mod = await import("/src/components/ThemeEditor.tsx");
    mod.openThemeEditor();
  });
}
await page.waitForTimeout(300);
if (!(await page.locator(".theme-editor").isVisible().catch(() => false))) {
  await page.locator(".palette-dot.custom").click();
  await page.waitForTimeout(300);
}
check(await page.locator(".theme-editor").isVisible(), "the custom theme editor opens");
check(
  await page.locator(".te-swatch").count() === 16,
  `editor shows sixteen swatches (${await page.locator(".te-swatch").count()})`,
);

// --- import a scheme ---
await page.locator(".ghost-btn", { hasText: "Import scheme…" }).click();
await page.waitForTimeout(250);
await page.locator(".te-paste").fill("not a scheme");
await page.locator(".ghost-btn", { hasText: "Apply" }).click();
await page.waitForTimeout(250);
check(await page.locator(".te-error").isVisible(), "an invalid scheme reports an error");
await page.locator(".te-paste").fill(DRACULA);
await page.locator(".ghost-btn", { hasText: "Apply" }).click();
await page.waitForTimeout(500);

check(await page.getAttribute(".app", "data-theme") === "custom", "importing switches to the custom slot");
check(await tokenOf("--bg-page") === "#282a36", "page surface came from base00");
check(await tokenOf("--ink") === "#f8f8f2", "body text came from base05");
check(await tokenOf("--accent") === "#80bfff", "accent came from base0D");
check(await tokenOf("--link") === "#8be9fd", "link came from base0C");
check(await tokenOf("--ink") !== saralaInk, "the injected stylesheet overrides the curated block");

// The derived in-between surfaces must actually differ from their neighbours.
const bg = await tokenOf("--bg");
check(
  bg !== (await tokenOf("--bg-page")) && bg !== (await tokenOf("--bg-panel")),
  `--bg is a mixed tone, not collapsed (${bg})`,
);

// --- the app really repaints, not just the variables ---
const editorBg = await page.evaluate(
  () => getComputedStyle(document.querySelector(".main")).backgroundColor,
);
check(editorBg === "rgb(40, 42, 54)", `the editor surface repainted to base00 (${editorBg})`);

// --- editing a swatch restyles live ---
await page.locator(".te-color").nth(13).evaluate((el) => {
  el.value = "#ff00ff";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(400);
check(await tokenOf("--accent") === "#ff00ff", "editing base0D restyles the accent live");

// --- persistence ---
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sarala.settings")));
check(saved.customScheme?.name === "Dracula", "the scheme is persisted");
check(saved.customScheme?.palette.base0D === "#ff00ff", "the swatch edit is persisted");

await page.reload();
await page.waitForSelector(".app");
await page.waitForTimeout(600);
check(await tokenOf("--accent") === "#ff00ff", "the custom theme survives a reload");

// --- curated themes are untouched ---
await page.evaluate(async () => {
  const mod = await import("/src/store.ts");
  mod.setTheme("sarala");
});
await page.waitForTimeout(400);
check(
  await tokenOf("--accent") === saralaAccent,
  `switching back restores the curated palette exactly (${await tokenOf("--accent")})`,
);
check(
  await tokenOf("--ink") === saralaInk,
  "curated tokens are unaffected by the custom stylesheet",
);

// --- the themes gallery ---
await page.evaluate(async () => {
  const m = await import("/src/components/ThemePicker.tsx");
  m.openThemePicker();
});
await page.waitForTimeout(600);
check(await page.locator(".theme-picker").isVisible(), "the themes gallery opens");
const cards = await page.locator(".tp-card").count();
check(cards === 14, `every theme has a card, custom included (${cards})`);

// Each preview carries its own data-theme, so it must paint in THAT theme's
// colours rather than the active one — the property that keeps previews honest.
const previewBgs = await page.locator(".tp-prev").evaluateAll((els) =>
  els.map((e) => getComputedStyle(e).getPropertyValue("--bg-page").trim()),
);
check(new Set(previewBgs).size > 6, `previews render in distinct palettes (${new Set(previewBgs).size} unique)`);
check(previewBgs[0] === "#faf6ef", `the Sarala card uses Sarala's page colour (${previewBgs[0]})`);

// Badges are measured from those computed values, not hardcoded.
const modes = await page.locator(".tp-mode").allTextContents();
check(modes[0] === "light", `Sarala reads as light (${modes[0]})`);
check(modes[1] === "dark", `Pro reads as dark (${modes[1]})`);
check(modes.filter((m) => m).length === 13, `all curated themes get a badge (${modes.filter((m) => m).length})`);

// Selecting from the gallery applies the theme.
await page.locator(".tp-card").nth(1).click();
await page.waitForTimeout(400);
check(await page.getAttribute(".app", "data-theme") === "pro", "clicking a card applies that theme");
check(
  await page.locator(".tp-card").nth(1).evaluate((el) => el.classList.contains("on")),
  "the applied card is marked selected",
);

// The custom card routes to the editor.
await page.locator(".tp-edit").click();
await page.waitForTimeout(400);
check(await page.locator(".theme-editor").isVisible(), "the Custom card's Edit opens the base16 editor");

// --- reaching the builder, and it staying put ---
// The gallery section above ends with the builder open; dismiss it so this
// section starts from a clean surface.
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
// It was only reachable four clicks deep (status bar → palette → All themes →
// Custom card → Edit) with nothing in Settings naming it.
await page.evaluate(async () => {
  const m = await import("/src/components/SettingsModal.tsx");
  m.openSettings("appearance");
});
await page.waitForTimeout(700);
const appearance = await page.locator(".set-row-label").allTextContents();
check(appearance.includes("Custom theme"), `Settings ▸ Appearance names the builder (${JSON.stringify(appearance)})`);
await page.locator(".set-row").filter({ hasText: "Custom theme" }).locator(".ghost-btn").click();
await page.waitForTimeout(600);
check(await page.locator(".theme-editor").isVisible(), "the Settings row opens the builder");

const editorOnTop = () =>
  page.locator(".theme-editor").evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + 20));
  });
// Opened from Settings, which stays open behind it.
check(await editorOnTop(), "the builder stacks above the dialog that opened it");

// A builder must survive clicking into the document — edits apply live, so
// judging a colour against real content is the expected interaction.
await page.mouse.click(60, 700);
await page.waitForTimeout(400);
check(await page.locator(".theme-editor").isVisible(), "clicking outside does not discard the builder");
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check(await page.locator(".theme-editor").count() === 0, "Escape closes the builder");

// Same drill-in from the gallery: it must close behind, not stack on top.
await page.evaluate(async () => {
  const m = await import("/src/components/ThemePicker.tsx");
  m.openThemePicker();
});
await page.waitForTimeout(500);
await page.locator(".tp-edit").click();
await page.waitForTimeout(600);
check(await page.locator(".theme-picker").count() === 0, "the gallery closes when drilling into the builder");
check(await editorOnTop(), "the builder is the topmost surface after the drill-in");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

await browser.close();
kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
