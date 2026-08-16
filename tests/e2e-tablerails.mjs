/**
 * Live-app check of the table "+" edge rails: real Vite dev server, real
 * Chromium, real layout measurement.
 *
 *   node tests/e2e-tablerails.mjs   (starts its own server on :1423)
 *
 * The unit tests (tests/format.test.mjs) cover the markdown appends. This
 * covers what only a live DOM can: that the rails measure onto the grid's real
 * edges, reveal on hover, and grow the table without stealing the caret.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1423;
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
const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

const activeText = () =>
  page.evaluate(() => document.querySelector(".block.active .source")?.textContent ?? null);
const dims = async () => {
  const t = await activeText();
  if (!t) return null;
  const lines = t.split("\n").filter((l) => l.trim());
  return { rows: lines.length - 1, cols: (lines[1].match(/-+/g) ?? []).length };
};

// Seed a table through the editor's own paste path: typing it would need
// Enter, which splits the block, and `insertText` collapses the newlines.
await page.locator(".block").first().click();
await page.waitForSelector(".block.active .source");
await page.evaluate((md) => {
  const el = document.querySelector(".block.active .source");
  const dt = new DataTransfer();
  dt.setData("text/plain", md);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, "| Platform | Files |\n| --- | --- |\n| macOS | .dmg |");
await page.waitForTimeout(400);

check(
  await page.locator(".block.active .source .md-table").isVisible(),
  "the table block renders as a live grid",
);
check(JSON.stringify(await dims()) === '{"rows":2,"cols":2}', "sanity: 2 rows x 2 cols");

const rails = page.locator(".tbl-rails");
check(await rails.count() === 1, "rails overlay is mounted for the table block");

// Geometry: each rail must sit flush against the grid's real edge.
const geom = await page.evaluate(() => {
  const t = document.querySelector(".block.active .source .md-table").getBoundingClientRect();
  const col = document.querySelector(".tbl-rail-col").getBoundingClientRect();
  const row = document.querySelector(".tbl-rail-row").getBoundingClientRect();
  return {
    colStartsAtRightEdge: Math.abs(col.left - t.right) < 2,
    colSpansHeight: Math.abs(col.height - t.height) < 2,
    rowStartsAtBottomEdge: Math.abs(row.top - t.bottom) < 2,
    rowSpansWidth: Math.abs(row.width - t.width) < 2,
  };
});
check(geom.colStartsAtRightEdge, "column rail is flush with the grid's right edge");
check(geom.colSpansHeight, "column rail spans the grid's full height");
check(geom.rowStartsAtBottomEdge, "row rail is flush with the grid's bottom edge");
check(geom.rowSpansWidth, "row rail spans the grid's full width");

// Reveal is CSS-only: transparent at rest, tinted + visible icon on hover.
const restColor = await page.locator(".tbl-rail-col").evaluate((el) => getComputedStyle(el).color);
check(restColor === "rgba(0, 0, 0, 0)", `rails are invisible at rest (color ${restColor})`);
await page.locator(".tbl-rail-col").hover();
await page.waitForTimeout(200);
const hotColor = await page.locator(".tbl-rail-col").evaluate((el) => getComputedStyle(el).color);
const hotBg = await page
  .locator(".tbl-rail-col")
  .evaluate((el) => getComputedStyle(el).backgroundColor);
check(hotColor !== "rgba(0, 0, 0, 0)", `hovering reveals the + icon (color ${hotColor})`);
check(hotBg !== "rgba(0, 0, 0, 0)", `hovering tints the strip (bg ${hotBg})`);

// Append a column.
await page.locator(".tbl-rail-col").click();
await page.waitForTimeout(400);
check(JSON.stringify(await dims()) === '{"rows":2,"cols":3}', `column appended (${await dims().then(JSON.stringify)})`);
check((await activeText()).includes("| Platform |"), "existing header content survives the append");
check(await page.evaluate(() => !!document.querySelector(".block.active")),
  "block stays active after clicking a rail");

// The caret should be waiting in the new cell, so typing just works.
await page.keyboard.type("Size");
await page.waitForTimeout(300);
const afterType = await activeText();
check(/\|\s*Platform\s*\|\s*Files\s*\|\s*Size\s*\|/.test(afterType),
  `caret landed in the new column's header (${JSON.stringify(afterType.split("\n")[0])})`);

// Rails re-measure onto the now-wider grid rather than going stale.
const regrown = await page.evaluate(() => {
  const t = document.querySelector(".block.active .source .md-table").getBoundingClientRect();
  const col = document.querySelector(".tbl-rail-col").getBoundingClientRect();
  return Math.abs(col.left - t.right) < 2;
});
check(regrown, "column rail re-measures onto the wider grid");

// Append a row.
await page.locator(".tbl-rail-row").click();
await page.waitForTimeout(400);
check(JSON.stringify(await dims()) === '{"rows":3,"cols":3}', `row appended (${await dims().then(JSON.stringify)})`);
await page.keyboard.type("Linux");
await page.waitForTimeout(300);
const rowText = (await activeText()).split("\n").filter((l) => l.trim()).pop();
check(/^\|\s*Linux\s*\|/.test(rowText), `caret landed in the new row's first cell (${JSON.stringify(rowText)})`);

// The rails belong to the active table only — they must not linger elsewhere.
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(await page.locator(".tbl-rails").count() === 0, "rails unmount when the block deactivates");

await browser.close();
kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
