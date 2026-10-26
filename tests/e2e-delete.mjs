/**
 * Deleting around concealed Markdown syntax (issue #19), in real Chromium:
 * the engine WebView2 uses on Windows, where native deletion of a selection
 * that crosses hidden markers did nothing, and Backspace at the start of a
 * heading or bold run removed an invisible `#` or `*`.
 *
 *   node tests/e2e-delete.mjs   (starts its own server on :1453)
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1453;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const server = spawn("npx", ["vite", "--port", String(PORT)], { stdio: "pipe" });
const kill = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", kill);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("vite did not start")), 20000);
  server.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); } });
});

let failures = 0;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failures++; };
const browser = await chromium.launch();
const context = await browser.newContext();
await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` });
const page = await context.newPage();
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

/** Load `md` as a one-block document, activate it, and place the selection. */
const edit = async (md, start, end = start) => {
  await page.evaluate(async (md) => {
    const store = await import("/src/store.ts");
    store.loadDocument(md, null);
    store.requestCaret(0);
    store.setActive(0);
  }, md);
  await page.waitForSelector(".block.active .source");
  await page.evaluate(async ({ start, end }) => {
    const { setSelection } = await import("/src/livesource.ts");
    const el = document.querySelector(".block.active .source");
    el.focus();
    setSelection(el, start, end);
  }, { start, end });
  // Let selectionchange re-apply marker visibility for the new caret.
  await page.waitForTimeout(80);
};
const text = () => page.evaluate(async () => (await import("/src/store.ts")).doc.blocks.map((b) => b.text).join("\n\n"));

// Selections.
await edit("Hello **world** and more", 8, 13);
await page.keyboard.press("Backspace");
check(await text() === "Hello  and more", `Backspace deletes a selected bold word with its markers (${JSON.stringify(await text())})`);

await edit("Hello **world** and more", 3, 11);
await page.keyboard.press("Backspace");
check(await text() === "Hel**ld** and more", `a selection cutting through bold keeps the delimiters (${JSON.stringify(await text())})`);

await edit("See [the docs](https://example.com) now", 5, 13);
await page.keyboard.press("Delete");
check(await text() === "See  now", `Delete takes a whole link when its label is selected (${JSON.stringify(await text())})`);

await edit("Hello **world** and more", 8, 13);
await page.keyboard.type("x");
check(await text() === "Hello **x** and more", `typing over a bold word keeps it bold (${JSON.stringify(await text())})`);

await edit("plain words here", 6, 11);
await page.keyboard.press("Backspace");
check(await text() === "plain  here", `Backspace deletes a plain selection (${JSON.stringify(await text())})`);

await edit("Hello **world** and more", 0, 15);
await page.keyboard.press(`${mod}+x`);
const clip = await page.evaluate(() => navigator.clipboard.readText());
check(await text() === " and more" && clip === "Hello **world**", `cut removes the selection and copies its Markdown (${JSON.stringify(await text())}, ${JSON.stringify(clip)})`);

// Collapsed caret next to hidden syntax.
await edit("Hello **world** and more", 8);
await page.keyboard.press("Backspace");
check(await text() === "Hello**world** and more", `Backspace at the start of bold deletes the visible space, not a * (${JSON.stringify(await text())})`);

await edit("# Title", 2);
await page.keyboard.press("Backspace");
check(await text() === "Title", `Backspace at a heading's start makes it a paragraph (${JSON.stringify(await text())})`);

await edit("- item", 2);
await page.keyboard.press("Backspace");
check(await text() === "item", `Backspace at a list item's start removes the bullet (${JSON.stringify(await text())})`);

await edit("first\n\n**bold** start", 0);
await page.evaluate(async () => {
  const { setCaret } = await import("/src/livesource.ts");
  const store = await import("/src/store.ts");
  store.requestCaret(2);
  store.setActive(1);
  await new Promise((r) => setTimeout(r, 50));
  const el = document.querySelector(".block.active .source");
  el.focus();
  setCaret(el, 2);
});
await page.waitForTimeout(80);
await page.keyboard.press("Backspace");
check(await text() === "first\n**bold** start", `Backspace with only hidden syntax before the caret merges blocks (${JSON.stringify(await text())})`);

await edit("Hello **world** and more", 13);
await page.keyboard.press("Delete");
check(await text() === "Hello **world**and more", `Delete at the end of bold deletes the visible space, not a * (${JSON.stringify(await text())})`);

await edit("an ordinary line", 3);
await page.keyboard.press("Backspace");
check(await text() === "anordinary line", `ordinary Backspace still works (${JSON.stringify(await text())})`);

await browser.close();
kill();
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
