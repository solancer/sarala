/**
 * Live-app check of the slash command menu: real Vite dev server, real
 * Chromium, real keyboard handling against the block's own key handler.
 *
 *   node tests/e2e-slashmenu.mjs   (starts its own server on :1426)
 *
 * The unit tests (tests/format.test.mjs) cover trigger detection and ranking.
 * This covers what only a live DOM can: that the menu claims Enter/arrows away
 * from the editor, that the `/query` text is gone from the source afterwards,
 * and that the item's command lands in the block the trigger was typed in.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1426;
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
const page = await browser.newPage({ viewport: { width: 1100, height: 720 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

const menu = page.locator(".slash-menu");
const activeText = () =>
  page.evaluate(() => document.querySelector(".block.active .source")?.textContent ?? null);
const allText = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".block")]
      .map((b) => b.querySelector(".source")?.textContent ?? b.querySelector(".rendered")?.textContent ?? "")
      .join("\n\n"),
  );
const labels = () => page.locator(".slash-item .slash-label").allTextContents();

/**
 * Back to a single empty block. Reloading rather than selecting-all-and-
 * deleting: Cmd+A is document-wide select-all here, which deactivates the
 * block and leaves nothing to type into.
 */
async function reset() {
  await page.reload();
  await page.waitForSelector(".block");
  await page.locator(".block").first().click();
  await page.waitForSelector(".block.active .source");
  await page.waitForTimeout(150);
}

await page.locator(".block").first().click();
await page.waitForSelector(".block.active .source");

// --- trigger ---
check(!(await menu.isVisible()), "no menu before typing");
await page.keyboard.type("/");
await page.waitForTimeout(300);
check(await menu.isVisible(), "typing / opens the menu");
check((await labels()).length > 20, `the full catalogue is offered (${(await labels()).length} items)`);
check(await page.locator(".slash-group").count() >= 4, "items are grouped");

// --- filtering ---
await page.keyboard.type("head");
await page.waitForTimeout(250);
const filtered = await labels();
check(filtered[0] === "Heading 1", `typing filters and ranks (${JSON.stringify(filtered.slice(0, 3))})`);

// --- arrows are claimed from the block ---
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(150);
check(
  await page.locator(".slash-item.on .slash-label").textContent() === "Heading 2",
  "ArrowDown moves the highlight instead of the caret",
);

// --- Enter runs the item ---
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
check(!(await menu.isVisible()), "Enter closes the menu");
const afterH2 = await activeText();
check(afterH2 === "## ", `block became a heading with the trigger removed (${JSON.stringify(afterH2)})`);
await page.keyboard.type("Title");
await page.waitForTimeout(200);
check(await activeText() === "## Title", "typing continues in the converted block");

// --- Escape dismisses without acting ---
await reset();
await page.keyboard.type("/quo");
await page.waitForTimeout(250);
check(await menu.isVisible(), "menu reopens on a fresh trigger");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check(!(await menu.isVisible()), "Escape closes the menu");
check(await activeText() === "/quo", "Escape leaves the typed text alone");

// --- a space dismisses ---
await page.keyboard.type(" ");
await page.waitForTimeout(200);
check(!(await menu.isVisible()), "a space after the query keeps the menu closed");

// --- an insert item replaces the empty block rather than leaving one behind ---
await reset();
await page.keyboard.type("/divider");
await page.waitForTimeout(250);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const doc1 = await allText();
check(doc1.trim() === "---", `divider replaced the blank block (${JSON.stringify(doc1)})`);

// --- a fenced diagram item inserts a starter body ---
await reset();
await page.keyboard.type("/mermaid");
await page.waitForTimeout(250);
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
const mermaid = await allText();
check(mermaid.includes("```mermaid"), "mermaid item inserts a mermaid fence");
check(mermaid.includes("flowchart TD"), "mermaid fence carries a starter body");

// --- a callout item ---
await reset();
await page.keyboard.type("/caution");
await page.waitForTimeout(250);
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
check((await allText()).includes("> [!CAUTION]"), "caution item inserts a GitHub alert");

// --- the guards ---
await reset();
await page.keyboard.type("src/foo");
await page.waitForTimeout(250);
check(!(await menu.isVisible()), "a path segment does not open the menu");

await reset();
await page.keyboard.type("```js");
await page.keyboard.press("Enter");
await page.waitForTimeout(250);
await page.keyboard.type("/head");
await page.waitForTimeout(250);
check(!(await menu.isVisible()), "no menu inside a fenced code block");

await browser.close();
kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
