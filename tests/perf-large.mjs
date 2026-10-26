/**
 * Large-document benchmark (issue #6): a generated 1.5M-character document
 * (~12,700 blocks of headings, formatted paragraphs, lists and code) timed
 * from open to first paint, then typing in a paragraph and in a heading.
 *
 *   node tests/perf-large.mjs                     # print timings (Chromium)
 *   WEBKIT=1 node tests/perf-large.mjs            # WebKit, the macOS/Linux engine
 *   node tests/perf-large.mjs --assert            # also fail over budget
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";

const ASSERT = process.argv.includes("--assert");
// Generous for CI machines; main took ~3.2 s to open and ~130 ms a keystroke
// on an M-series Mac before the fixes for #6.
const BUDGET = { open: 2500, typing: 100 };
const PORT = 1466;
const server = spawn("node", ["node_modules/vite/bin/vite.js", "--port", String(PORT), "--strictPort"], { stdio: "pipe" });
const kill = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", kill);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("vite did not start")), 20000);
  server.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); } });
});

const para = (i) => `Paragraph ${i} with **bold**, *italic*, \`code\` and a [link](https://example.com/${i}). `
  + "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ".repeat(2);
const parts = [];
for (let i = 0; parts.join("\n\n").length < 1_500_000; i++) {
  parts.push(`## Section ${i}`, para(i), `- item a ${i}\n- item b ${i}\n- item c ${i}`, para(i + 1), "```js\nconst x = " + i + ";\nconsole.log(x);\n```");
}
const doc = parts.join("\n\n");

const browser = await (process.env.WEBKIT ? webkit : chromium).launch();
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => { throw e; });
  await page.goto(`http://localhost:${PORT}`);
  await page.waitForSelector(".block");
  await page.evaluate((d) => { window.__doc = d; }, doc);
  const open = await page.evaluate(async () => {
    const store = await import("/src/store.ts");
    const t0 = performance.now();
    store.openDocument(window.__doc, "/large.md");
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    return { ms: performance.now() - t0, blocks: store.doc.blocks.length };
  });
  /** Median time from a keystroke in `block` to the next frame. */
  const typeIn = async (block) => {
    await page.evaluate(async () => (await import("/src/store.ts")).setActive(-1));
    await page.locator(".page > .block").nth(block).locator(".rendered").click();
    await page.waitForSelector(".block.active .source");
    const times = [];
    for (let k = 0; k < 9; k++) {
      times.push(await page.evaluate(() => new Promise((resolve) => {
        const t0 = performance.now();
        document.execCommand("insertText", false, "x");
        requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - t0), 0));
      })));
    }
    // The first keystroke pays one-off costs; report the median of the rest.
    return times.slice(1).sort((a, b) => a - b)[4];
  };
  // Moving the caret to another block: deactivate one, activate the next.
  const activate = [];
  for (let k = 0; k < 7; k++) {
    activate.push(await page.evaluate(async (k) => {
      const store = await import("/src/store.ts");
      const t0 = performance.now();
      store.setActive(k % 2 ? 3 : 5);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return performance.now() - t0;
    }, k));
  }
  const activation = activate.slice(1).sort((a, b) => a - b)[3];
  const median = await typeIn(1); // a paragraph
  const heading = await typeIn(0); // a heading, which changes the outline
  console.log(`${browser.browserType().name()}: ${doc.length} chars, ${open.blocks} blocks`);
  console.log(`open to first paint   ${Math.round(open.ms)} ms (budget ${BUDGET.open})`);
  console.log(`typing, median        ${Math.round(median)} ms (budget ${BUDGET.typing})`);
  console.log(`typing in a heading   ${Math.round(heading)} ms (budget ${BUDGET.typing})`);
  console.log(`moving to a block     ${Math.round(activation)} ms (budget ${BUDGET.typing})`);
  if (ASSERT) {
    assert.ok(open.ms <= BUDGET.open, `open took ${Math.round(open.ms)} ms`);
    assert.ok(median <= BUDGET.typing, `typing took ${Math.round(median)} ms`);
    assert.ok(heading <= BUDGET.typing, `typing in a heading took ${Math.round(heading)} ms`);
    assert.ok(activation <= BUDGET.typing, `moving to a block took ${Math.round(activation)} ms`);
    console.log("within budget");
  }
} finally {
  await browser.close();
  kill();
}
