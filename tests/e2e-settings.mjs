/**
 * Live-app check of the settings dialog: real Vite dev server, real Chromium.
 *
 *   node tests/e2e-settings.mjs   (starts its own server on :1437)
 *
 * The point of the dialog is that it drives the *existing* commands rather than
 * setting state itself, so these checks care about one thing above all: that
 * flipping a row changes the real setting and persists it, exactly as the menu
 * item would.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1437;
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
const page = await browser.newPage({ viewport: { width: 1240, height: 880 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".app");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

const open = () =>
  page.evaluate(async () => {
    const m = await import("/src/components/SettingsModal.tsx");
    m.openSettings();
  });
const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("sarala.settings") ?? "{}"));
const rowNamed = (name) => page.locator(".set-row").filter({ hasText: name }).first();

await open();
await page.waitForTimeout(600);
check(await page.locator(".settings").isVisible(), "the settings dialog opens");

// --- layout: rail beside the pane, not stacked above it ---
const dialog = await page.locator(".settings").boundingBox();
const rail = await page.locator(".set-rail").boundingBox();
const pane = await page.locator(".set-pane").boundingBox();
check(rail.x < pane.x, "the rail sits to the left of the content pane");
check(rail.height > dialog.height * 0.8, "the rail spans the dialog's height");

// --- categories ---
const sections = await page.locator(".set-rail-item").allTextContents();
check(
  JSON.stringify(sections) === '["Appearance","Editor","Markdown","Files","Images","Fonts"]',
  `six categories in order (${JSON.stringify(sections)})`,
);
{
  const labels = await page.locator(".set-row-label").allTextContents();
  check(
    JSON.stringify(labels) === '["Theme","Custom theme","Zoom","Status bar","Full-width tables"]',
    `Appearance opens by default with its rows (${JSON.stringify(labels)})`,
  );
}

await page.locator(".set-rail-item", { hasText: "Markdown" }).click();
await page.waitForTimeout(300);
{
  const labels = await page.locator(".set-row-label").allTextContents();
  check(
    labels.length === 10 && labels[0] === "Preserve single line breaks" && !labels.includes("Theme"),
    `switching category swaps the rows (${JSON.stringify(labels)})`,
  );
}
check(
  await page.locator(".set-rail-item.on").textContent() === "Markdown",
  "the selected category is marked",
);

// --- a toggle drives the real setting and persists ---
const emoji = rowNamed("Emoji shortcodes");
const before = await page.evaluate(async () => (await import("/src/store.ts")).emojiEnabled());
check(
  (await emoji.locator(".set-switch.on").count() === 1) === before,
  `the switch reflects the live value (${before})`,
);
await emoji.locator(".set-switch").click();
await page.waitForTimeout(400);
const after = await page.evaluate(async () => (await import("/src/store.ts")).emojiEnabled());
check(after === !before, "flipping the switch changes the underlying setting");
check((await stored()).emojiEnabled === after, "the change is persisted to settings");
check(
  (await emoji.locator(".set-switch.on").count() === 1) === after,
  "the switch redraws to the new state",
);
await emoji.locator(".set-switch").click();
await page.waitForTimeout(300);

// --- selects reflect and apply ---
await page.locator(".set-rail-item", { hasText: "Files" }).click();
await page.waitForTimeout(300);
const autosave = rowNamed("Autosave").locator("select");
check(await autosave.inputValue() === "5", `autosave shows its current value (${await autosave.inputValue()})`);
await autosave.selectOption("30");
await page.waitForTimeout(400);
check(
  await page.evaluate(async () => (await import("/src/store.ts")).autosaveInterval()) === 30,
  "choosing an option applies it",
);
// "Off" maps to the `edit.autosave.off` command, not `.0` — the mapping that
// would silently leave the select blank if it used the raw number.
await autosave.selectOption("off");
await page.waitForTimeout(400);
check(
  await page.evaluate(async () => (await import("/src/store.ts")).autosaveInterval()) === 0,
  "the Off option maps to interval 0",
);
check(await autosave.inputValue() === "off", "the select still shows Off after applying it");

// --- search spans every category ---
await page.locator(".set-pane-head .settings-search").fill("newline");
await page.waitForTimeout(400);
const groups = await page.locator(".set-group").allTextContents();
check(groups.length >= 2, `search crosses categories (${JSON.stringify(groups)})`);
check(groups.includes("Markdown") && groups.includes("Files"), "results keep their category heading");
await page.locator(".set-pane-head .settings-search").fill("zzzznope");
await page.waitForTimeout(300);
check(
  (await page.locator(".settings-empty").textContent()).includes("No settings match"),
  "search has an empty state",
);
await page.locator(".set-pane-head .settings-search").fill("");
await page.waitForTimeout(300);

// --- the Fonts category still hosts the original picker ---
await page.locator(".set-rail-item", { hasText: "Fonts" }).click();
await page.waitForTimeout(700);
check(await page.locator(".settings-tabs").isVisible(), "Fonts shows the editor/code font tabs");
check(await page.locator(".settings-list").isVisible(), "Fonts shows the font list");

// --- Appearance routes to the themes gallery ---
await page.locator(".set-rail-item", { hasText: "Appearance" }).click();
await page.waitForTimeout(300);
await rowNamed("Theme").locator(".ghost-btn").click();
await page.waitForTimeout(500);
check(await page.locator(".theme-picker").isVisible(), "the Theme row opens the themes gallery");

await browser.close();
kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
