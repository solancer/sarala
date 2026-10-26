/**
 * Switching between Live and Source keeps the reading position, in a normal
 * document and in a long, windowed one.
 *
 *   node tests/e2e-viewswitch.mjs            (starts its own server on :1470)
 *   WEBKIT=1 node tests/e2e-viewswitch.mjs   (WebKit, the macOS/Linux engine)
 */
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";

const PORT = 1470;
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

const docOf = (n) => Array.from({ length: n }, (_, i) =>
  i % 3 === 0 ? `## Heading ${i}` : `Paragraph ${i}. ` + "Words that wrap across the line in both views. ".repeat(i % 5 + 1)).join("\n\n");
const settle = () => page.waitForTimeout(300);
const toggle = (source) => page.evaluate(async (source) => (await import("/src/viewswitch.ts")).showSource(source), source);
/** Index of the block at the top of the Live viewport. */
const topBlock = () => page.evaluate(() => {
  const top = document.querySelector(".scroll").getBoundingClientRect().top;
  return [...document.querySelectorAll(".page > .block")].findIndex((b) => b.getBoundingClientRect().bottom > top + 1);
});

for (const [label, n] of [["a normal document", 150], ["a long, windowed document", 900]]) {
  await page.evaluate(async (md) => {
    const store = await import("/src/store.ts");
    (await import("/src/viewswitch.ts")).showSource(false);
    store.loadDocument(md, null);
    store.setActive(-1);
    document.querySelector(".scroll").scrollTop = 0;
  }, docOf(n));
  await settle();
  const target = Math.floor(n * 0.6);
  await page.evaluate((i) => document.querySelectorAll(".page > .block")[i].scrollIntoView({ block: "start" }), target);
  await settle();
  const before = await topBlock();

  await toggle(true);
  await settle();
  const source = await page.evaluate(() => {
    const scroll = document.querySelector(".scroll");
    const area = document.querySelector("textarea.source-full");
    return { top: scroll.scrollTop, height: area.scrollHeight, value: area.value };
  });
  // Where that block's text sits in the source, as a share of it: the view
  // should be about as far down the textarea.
  const share = source.value.indexOf(`${before % 3 === 0 ? "## Heading" : "Paragraph"} ${before}`) / source.value.length;
  const viewShare = source.top / source.height;
  check(Math.abs(viewShare - share) < 0.03, `Source opens where Live was in ${label} (${viewShare.toFixed(3)} vs ${share.toFixed(3)})`);

  await toggle(false);
  await settle();
  const after = await topBlock();
  check(Math.abs(after - before) <= 1, `Live returns to the same block in ${label} (${before} → ${after})`);
}

// Starting from Source: scroll the textarea, switch, and land on the block there.
await page.evaluate(async () => (await import("/src/viewswitch.ts")).showSource(true));
await settle();
const scrolled = await page.evaluate(() => {
  const scroll = document.querySelector(".scroll");
  scroll.scrollTop = scroll.scrollHeight * 0.3;
  return scroll.scrollTop / document.querySelector("textarea.source-full").scrollHeight;
});
await toggle(false);
await settle();
const landed = await page.evaluate(() => {
  const scroll = document.querySelector(".scroll");
  const top = scroll.getBoundingClientRect().top;
  const blocks = [...document.querySelectorAll(".page > .block")];
  return blocks.findIndex((b) => b.getBoundingClientRect().bottom > top + 1) / blocks.length;
});
check(Math.abs(landed - scrolled) < 0.05, `Live opens where Source was (${landed.toFixed(3)} of the blocks vs ${scrolled.toFixed(3)} of the text)`);

await browser.close();
kill();
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
