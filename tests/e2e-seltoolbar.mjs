/**
 * Live-app check of the selection formatting toolbar: real Vite dev server,
 * real Chromium, real selectionchange / mouseup timing.
 *
 *   node tests/e2e-seltoolbar.mjs   (starts its own server on :1422)
 *
 * The unit tests (tests/format.test.mjs) cover the markdown edits. This covers
 * what only a live DOM can: when the bar shows, where it lands, and that
 * clicking it never blurs the block it is formatting.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1422;
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
const page = await browser.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

const bar = page.locator(".sel-bar");
const activeText = () =>
  page.evaluate(() => document.querySelector(".block.active .source")?.textContent ?? null);

/** Select `word` inside the active block by dragging across its client rect. */
async function selectWord(word) {
  const box = await page.evaluate((w) => {
    const el = document.querySelector(".block.active .source");
    const target = el.textContent.indexOf(w);
    if (target < 0) return null;
    const range = document.createRange();
    let remaining = target;
    let startNode = null;
    let startOff = 0;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (remaining <= n.data.length) { startNode = n; startOff = remaining; break; }
      remaining -= n.data.length;
    }
    if (!startNode) return null;
    range.setStart(startNode, startOff);
    // Walk forward w.length characters for the end.
    let left = w.length;
    let node = startNode;
    let off = startOff;
    while (node) {
      const avail = node.data.length - off;
      if (left <= avail) { range.setEnd(node, off + left); break; }
      left -= avail;
      node = walker.nextNode();
      off = 0;
    }
    const r = range.getBoundingClientRect();
    return { x0: r.left + 1, y: r.top + r.height / 2, x1: r.right - 1 };
  }, word);
  if (!box) throw new Error(`"${word}" not in the active block`);
  await page.mouse.move(box.x0, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x1, box.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

// The app launches on a blank Untitled document, so type our own content.
await page.locator(".block").first().click();
await page.waitForSelector(".block.active .source");
// Two paragraphs: the selection goes in the second, so there is room above it.
// A selection in the *first* block sits under the floating controls and the bar
// deliberately flips below — covered separately at the end.
await page.keyboard.type("A first paragraph, so the selection below has room above it.");
await page.keyboard.press("Enter");
await page.keyboard.type("Split panes duplicate the work.");
await page.waitForTimeout(150);

check(!(await bar.isVisible()), "no bar for a collapsed caret");

await selectWord("panes");
check(await bar.isVisible(), "bar appears for a text selection");

// Anchoring: the bar must sit near the selection, not at a fixed corner.
const anchored = await page.evaluate(() => {
  const b = document.querySelector(".sel-bar").getBoundingClientRect();
  const s = window.getSelection().getRangeAt(0).getBoundingClientRect();
  return {
    horizontallyNear: Math.abs((b.left + b.width / 2) - (s.left + s.width / 2)) < 40,
    above: b.bottom <= s.top + 1,
    inViewport: b.left >= 0 && b.right <= window.innerWidth,
  };
});
check(anchored.horizontallyNear, "bar is centered on the selection");
check(anchored.above, "bar sits above the selection");
check(anchored.inViewport, "bar is clamped inside the viewport");

// The block-type dropdown reflects the block it is over.
check(
  (await page.locator(".sel-type-label").textContent()) === "Text",
  "dropdown reads 'Text' for a paragraph",
);

// Bold: click must format without blurring the block.
const before = await activeText();
await page.locator(".sel-btn[aria-label='Bold']").click();
await page.waitForTimeout(200);
const afterBold = await activeText();
check(afterBold !== null, "block stays active after clicking the toolbar");
check(
  afterBold === before.replace("panes", "**panes**"),
  `bold wraps the selected word (got ${JSON.stringify(afterBold?.slice(0, 40))})`,
);
check(await bar.isVisible(), "bar stays up after a format click");
check(
  await page.locator(".sel-btn[aria-label='Bold']").evaluate((el) => el.classList.contains("on")),
  "bold button reads back as active",
);

// Clicking again un-bolds — the round trip the unit tests assert, live.
await page.locator(".sel-btn[aria-label='Bold']").click();
await page.waitForTimeout(200);
check(await activeText() === before, "clicking bold again restores the source");

// Block-type conversion through the dropdown.
await page.locator(".sel-type-btn").click();
await page.waitForTimeout(100);
check(await page.locator(".sel-menu").isVisible(), "block-type menu opens");
await page.locator(".sel-menu-item", { hasText: "Heading 2" }).click();
await page.waitForTimeout(200);
const heading = await activeText();
check(heading?.startsWith("## "), `converted to a heading (got ${JSON.stringify(heading?.slice(0, 20))})`);
check(
  (await page.locator(".sel-type-label").textContent()) === "Heading 2",
  "dropdown label follows the conversion",
);

// Back to a paragraph so the demo doc is left as found.
await page.locator(".sel-type-btn").click();
await page.waitForTimeout(100);
await page.locator(".sel-menu-item", { hasText: "Text" }).first().click();
await page.waitForTimeout(200);
check(await activeText() === before, "converting back restores the paragraph");

// Near the top of the document the bar must never cover the document toolbar.
await page.locator(".block .rendered").first().click();
await page.waitForSelector(".block.active .source");
await page.waitForTimeout(150);
const barGeometry = () => page.evaluate(() => {
  const b = document.querySelector(".sel-bar").getBoundingClientRect();
  const s = window.getSelection().getRangeAt(0).getBoundingClientRect();
  const edge = document.querySelector(".main .scroll").getBoundingClientRect().top;
  return { below: b.top >= s.bottom - 1, clearsControls: b.top >= edge };
});
await selectWord("first");
check(await bar.isVisible(), "bar appears for a selection in the first block");
check((await barGeometry()).clearsControls, "a bar near the top stays clear of the document toolbar");
// With the first line flush under the toolbar there is no room above, so the
// bar flips below the selection.
await page.addStyleTag({ content: ".page { padding-top: 0 !important; } .page > .block:first-child .source { margin-top: 0 !important; }" });
await page.keyboard.press("ArrowRight"); // collapse, so the next drag selects rather than drags
await page.waitForTimeout(150);
await selectWord("first");
const flipped = await barGeometry();
check(flipped.below, "with no room above, the bar flips below the selection");
check(flipped.clearsControls, "the flipped bar clears the document toolbar");

// Escape dismisses.
await page.keyboard.press("Escape");
await page.waitForTimeout(120);
check(!(await bar.isVisible()), "Escape hides the bar");

// A fenced code block has no inline markup — the bar must stay away.
// (Escape above also deactivated the block, so re-enter it first.)
await page.locator(".block .rendered").first().click();
await page.waitForSelector(".block.active .source");
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
await page.keyboard.type("```js");
await page.keyboard.press("Enter");
await page.keyboard.type("const paned = 1;");
await page.waitForTimeout(200);
const isFence = await page.evaluate(() =>
  /^\s*(`{3,}|~{3,})/.test(document.querySelector(".block.active .source")?.textContent ?? ""),
);
check(isFence, `sanity: the new block is fenced (${JSON.stringify(await activeText())})`);
await selectWord("paned");
check(!(await bar.isVisible()), "no bar inside a fenced code block");

await browser.close();
kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
