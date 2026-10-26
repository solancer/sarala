/**
 * Editing a selection made outside the block being edited (issue #5): across
 * blocks, or dragged inside a rendered block. Delete, typing, paste, cut and
 * copy act on exactly the selected text, never on whole blocks.
 *
 *   node tests/e2e-selection-edit.mjs            (starts its own server on :1454)
 *   WEBKIT=1 node tests/e2e-selection-edit.mjs   (WebKit, the macOS/Linux engine)
 */
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";

const PORT = 1454;
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
const isWebKit = !!process.env.WEBKIT;
const browser = await (isWebKit ? webkit : chromium).launch();
const context = await browser.newContext();
// WebKit can't grant clipboard access: the clipboard checks run in Chromium.
if (!isWebKit) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: `http://localhost:${PORT}` });
const page = await context.newPage();
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

const text = () => page.evaluate(async () => (await import("/src/store.ts")).doc.blocks.map((b) => b.text).join("\n\n"));
/** Load `md` with no block being edited, then select rendered text from just
 *  before `from[1]` chars into the first match of `from[0]`, to `to[1]` chars
 *  into the first match of `to[0]`. */
const select = async (md, from, to) => {
  await page.evaluate(async (md) => {
    const store = await import("/src/store.ts");
    store.loadDocument(md, null);
    store.setActive(-1);
  }, md);
  await page.waitForTimeout(150);
  await page.evaluate(({ from, to }) => {
    const find = ([needle, at]) => {
      const walker = document.createTreeWalker(document.querySelector(".page"), NodeFilter.SHOW_TEXT);
      for (let node; (node = walker.nextNode());) {
        const i = node.data.indexOf(needle);
        if (i >= 0) return [node, i + at];
      }
      throw new Error(`Missing text: ${needle}`);
    };
    const r = document.createRange();
    r.setStart(...find(from));
    r.setEnd(...find(to));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }, { from, to });
};
const three = "alpha one\n\nbeta two\n\ngamma three";

await select(three, ["alpha", 4], ["gamma", 4]);
await page.keyboard.press("Backspace");
check(await text() === "alpha three", `Backspace across blocks deletes only the selection (${JSON.stringify(await text())})`);
check(await page.evaluate(async () => (await import("/src/store.ts")).doc.activeIndex) === 0, "editing continues where the selection was");

await select(three, ["alpha", 4], ["gamma", 4]);
await page.keyboard.type("Z");
check(await text() === "alphZa three", `typing replaces a selection across blocks (${JSON.stringify(await text())})`);

await select("alpha **one** two\n\nbeta", ["alpha", 0], ["one", 1]);
await page.keyboard.press("Backspace");
check(await text() === "**ne** two\n\nbeta", `a selection inside a rendered block is deleted, bold kept (${JSON.stringify(await text())})`);

await select("alpha **one** two", ["one", 0], ["one", 3]);
await page.keyboard.press("Delete");
check(await text() === "alpha  two", `selecting a rendered bold word deletes its markers too (${JSON.stringify(await text())})`);

await page.evaluate(async () => (await import("/src/blockselect.ts")).selectAllDocument());
await page.waitForTimeout(150);
await page.keyboard.press("Backspace");
check(await text() === "", `Select All then Backspace clears the document (${JSON.stringify(await text())})`);

if (!isWebKit) {
  await page.evaluate(() => navigator.clipboard.writeText("PASTED"));
  await select(three, ["alpha", 4], ["gamma", 4]);
  await page.keyboard.press(`${mod}+v`);
  await page.waitForTimeout(100);
  check(await text() === "alphPASTEDa three", `paste replaces a selection across blocks (${JSON.stringify(await text())})`);

  await select(three, ["alpha", 4], ["gamma", 4]);
  await page.keyboard.press(`${mod}+c`);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check(copied === "a one\n\nbeta two\n\ngamm" && await text() === three, `copy takes only the selected source (${JSON.stringify(copied)})`);

  await select(three, ["beta", 0], ["beta", 4]);
  await page.keyboard.press(`${mod}+x`);
  const cut = await page.evaluate(() => navigator.clipboard.readText());
  check(cut === "beta" && await text() === "alpha one\n\n two\n\ngamma three", `cut inside a rendered block (${JSON.stringify(cut)}, ${JSON.stringify(await text())})`);
}

// A selection inside the block being edited stays that block's own.
await page.evaluate(async () => {
  const store = await import("/src/store.ts");
  store.loadDocument("one two three", null);
  store.requestCaret(0);
  store.setActive(0);
});
await page.waitForSelector(".source");
await page.evaluate(async () => {
  const { setSelection } = await import("/src/livesource.ts");
  const el = document.querySelector(".source");
  el.focus();
  setSelection(el, 4, 8);
});
await page.keyboard.press("Backspace");
check(await text() === "one three", `a selection in the edited block is deleted once (${JSON.stringify(await text())})`);

await browser.close();
kill();
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
