/**
 * Windowed rendering of long documents (issue #6): blocks far from the
 * viewport are placeholders, scrolling renders them without moving the text
 * being read, and find, print and editing still see the whole document.
 *
 *   node tests/e2e-windowing.mjs            (starts its own server on :1467)
 *   WEBKIT=1 node tests/e2e-windowing.mjs   (WebKit, the macOS/Linux engine)
 */
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";

const PORT = 1467;
const server = spawn("node", ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
const kill = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", kill);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("vite did not start")), 20000);
  server.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); } });
});

let failures = 0;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failures++; };
const browser = await (process.env.WEBKIT ? webkit : chromium).launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

const parts = [];
for (let i = 0; i < 400; i++) {
  parts.push(`## Section ${i}`, `Paragraph ${i} with **bold** text. ` + "Filler words to wrap the line a little. ".repeat(i % 4 + 1), `- item ${i}\n- more ${i}`);
}
parts.push("The very last needle paragraph.");
const long = parts.join("\n\n");

const load = (md) => page.evaluate(async (md) => {
  const store = await import("/src/store.ts");
  store.loadDocument(md, null);
  store.setActive(-1);
  document.querySelector(".scroll").scrollTop = 0;
}, md);
const counts = () => page.evaluate(() => ({
  blocks: document.querySelectorAll(".page > .block").length,
  rendered: document.querySelectorAll(".page > .block > .rendered").length,
}));
const settle = () => page.waitForTimeout(250);
const scrollTo = (y) => page.evaluate((y) => { document.querySelector(".scroll").scrollTop = y; }, y);

await load("# Short\n\nA small document renders every block.");
await settle();
let c = await counts();
check(c.rendered === c.blocks, `a short document renders every block (${c.rendered}/${c.blocks})`);

await load(long);
await settle();
c = await counts();
check(c.blocks === parts.length, `every block keeps its element (${c.blocks}/${parts.length})`);
check(c.rendered > 0 && c.rendered < 200, `only blocks near the viewport render (${c.rendered})`);
check(await page.locator(".page > .block .rendered", { hasText: "Section 0" }).count() > 0, "the top of the document is rendered");

// Jump far down: blocks there render, the top turns into placeholders.
await scrollTo(await page.evaluate(() => document.querySelector(".scroll").scrollHeight));
await settle();
check(await page.locator(".rendered", { hasText: "The very last needle" }).count() === 1, "scrolling to the end renders the last block");
check(await page.locator(".rendered", { hasText: "Section 0" }).count() === 0, "blocks scrolled far away become placeholders");

// Reading position stays put while blocks above the viewport render with
// heights other than their placeholders' estimates. Jump into a stretch never
// rendered, then scroll up: the blocks that come into range above must not
// shift the text, so it ends up exactly as far down as the scroll.
await page.evaluate(() => document.querySelectorAll(".page > .block")[600].scrollIntoView({ block: "start" }));
await settle();
const anchor = await page.evaluate(() => {
  const top = document.querySelector(".scroll").getBoundingClientRect().top;
  const el = [...document.querySelectorAll(".page > .block")].find((b) => b.querySelector(".rendered") && b.getBoundingClientRect().top > top + 100);
  return [...document.querySelectorAll(".page > .block")].indexOf(el);
});
const topAt = (i) => page.evaluate((i) => Math.round(document.querySelectorAll(".page > .block")[i].getBoundingClientRect().top), i);
const before = await topAt(anchor);
await page.evaluate(() => { document.querySelector(".scroll").scrollTop -= 1500; });
await settle();
await page.evaluate(() => { document.querySelector(".scroll").scrollTop -= 1500; });
await settle();
const after = await topAt(anchor);
check( Math.abs(after - before - 3000) <= 2, `text being read doesn't jump as blocks render (${before} → ${after}, expected ${before + 3000})`);

// Editing a block far down the document.
// Not rendered yet: reach it through its block element, as the outline does.
await page.evaluate(() => document.querySelectorAll(".page > .block")[901].scrollIntoView({ block: "center" }));
await settle();
await page.locator(".rendered", { hasText: "Paragraph 300 with" }).click();
await page.waitForSelector(".block.active .source");
await page.keyboard.press("End");
await page.keyboard.type(" EDITED");
const edited = await page.evaluate(async () => (await import("/src/store.ts")).doc.blocks.find((b) => b.text.startsWith("Paragraph 300 ")).text);
check(edited.includes(" EDITED"), `a block far down can be edited (${JSON.stringify(edited)})`);
await page.evaluate(async () => (await import("/src/store.ts")).setActive(-1));

// Find sees text in blocks that aren't rendered, and windowing resumes after.
await scrollTo(0);
await settle();
await page.evaluate(async () => (await import("/src/components/FindBar.tsx")).openFindWith("very last needle"));
await page.waitForTimeout(300);
const found = await page.evaluate(() => {
  const r = CSS.highlights?.get("sarala-find-current");
  const range = r && [...r][0];
  return range ? { text: range.toString(), visible: range.getBoundingClientRect().top < window.innerHeight } : null;
});
check(found?.text.toLowerCase() === "very last needle" && found.visible, `find matches and shows text far down the document (${JSON.stringify(found)})`);
await page.evaluate(async () => (await import("/src/components/FindBar.tsx")).closeFind());
await settle();
c = await counts();
check(c.rendered < 200, `windowing resumes when find closes (${c.rendered} rendered)`);

// Print renders everything.
await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
c = await counts();
check(c.rendered === c.blocks, `printing renders every block (${c.rendered}/${c.blocks})`);
await page.evaluate(() => window.dispatchEvent(new Event("afterprint")));
await settle();
c = await counts();
check(c.rendered < 200, `windowing resumes after printing (${c.rendered} rendered)`);

// A selection across the whole document still edits the source.
await page.evaluate(async () => (await import("/src/blockselect.ts")).selectAllDocument());
await page.waitForTimeout(150);
await page.keyboard.press("Backspace");
const left = await page.evaluate(async () => (await import("/src/store.ts")).doc.blocks.map((b) => b.text).join(""));
check(left === "", `Select All then Backspace clears a long document (${left.length} chars left)`);

await browser.close();
kill();
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
