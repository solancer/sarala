/**
 * Browser test for src/d2.ts: bundle the helper (with real @terrastruct/d2),
 * drive renderD2In directly against placeholder markup like renderMarkdown
 * emits, in Chromium and in WebKit (the engine behind the macOS app's
 * WKWebView). Covers a valid diagram → SVG and an invalid one → inline error.
 *
 *   node tests/e2e-d2.mjs
 */
import { build } from "esbuild";
import { chromium, webkit } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, ".build", "d2-bundle.js");
await build({
  entryPoints: [path.join(here, "..", "src", "d2.ts")],
  bundle: true,
  format: "iife",
  globalName: "D2Helper",
  outfile,
});
const bundle = readFileSync(outfile, "utf8");

// d2.js loads its worker from a blob: URL, which an about:blank page can't do, so serve a real page.
const pageHtml = `<!doctype html><html><body>
  <div class="app">
    <div id="good" class="rendered"><div class="d2-block" data-d2="a -&gt; b: hello"></div></div>
    <div id="bad" class="rendered"><div class="d2-block" data-d2="a -&gt; {"></div></div>
    <div id="par1" class="rendered"><div class="d2-block" data-d2="x -&gt; y"></div></div>
    <div id="par2" class="rendered"><div class="d2-block" data-d2="p -&gt; q"></div></div>
    ${[100, 50, 200].map((z) => `<div id="z${z}" class="rendered" style="width:300px"><div class="d2-block"
      ${z === 100 ? "" : `style="zoom:${z}%;--d2-zoom:${z / 100}"`}
      data-d2="direction: right&#10;a -&gt; b -&gt; c -&gt; d -&gt; e -&gt; f -&gt; g"></div></div>`).join("")}
  </div>
  <link rel="stylesheet" href="/app.css">
  <script src="/d2-bundle.js"></script>
</body></html>`;
const appCss = readFileSync(path.join(here, "..", "src", "styles", "app.css"), "utf8");
const server = createServer((req, res) =>
  req.url === "/d2-bundle.js" ? res.writeHead(200, { "content-type": "text/javascript" }).end(bundle)
  : req.url === "/app.css" ? res.writeHead(200, { "content-type": "text/css" }).end(appCss)
  : res.writeHead(200, { "content-type": "text/html" }).end(pageHtml));
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;

let failures = 0;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failures++; };

for (const engine of [chromium, webkit]) {
  const name = engine.name();
  const browser = await engine.launch();
  const page = await browser.newPage();
  await page.goto(url);
  const render = (sel, key) =>
    page.evaluate(([sel, key]) => window.D2Helper.renderD2In(document.querySelector(sel), key), [sel, key]);

  await render("#good", "k-good");
  const err = await page.locator("#good .render-error").textContent().catch(() => null);
  check(await page.locator("#good svg").count() > 0, `${name}: valid d2 renders an SVG${err ? ` (got: ${err})` : ""}`);

  await render("#bad", "k-bad");
  check(await page.locator("#bad .render-error").count() > 0, `${name}: invalid d2 shows an inline error`);

  // Two views (document + source preview) fill their diagrams at the same time.
  await page.evaluate(() => Promise.race([
    Promise.all(["#par1", "#par2"].map((s) => window.D2Helper.renderD2In(document.querySelector(s)))),
    new Promise((r) => setTimeout(r, 30000)), // a lost reply never settles
  ]));
  for (const sel of ["#par1", "#par2"]) {
    const text = await page.locator(sel).textContent();
    check(await page.locator(`${sel} svg`).count() > 0, `${name}: concurrent render ${sel} gives an SVG (got: ${text?.slice(0, 60)})`);
  }

  // A diagram wider than its column: 100% fits the column, zoom scales from there.
  const width = {};
  for (const z of [100, 50, 200]) {
    await render(`#z${z}`, `k-z${z}`);
    width[z] = await page.locator(`#z${z} .d2-block > svg`).evaluate((el) => el.getBoundingClientRect().width);
  }
  check(Math.abs(width[100] - 300) < 2, `${name}: zoom 100% fits a wide diagram to the column (${width[100]})`);
  check(Math.abs(width[50] - 150) < 2, `${name}: zoom 50% halves it (${width[50]})`);
  check(Math.abs(width[200] - 600) < 2, `${name}: zoom 200% doubles it (${width[200]})`);

  await browser.close();
}

server.close();
if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall d2 checks passed");
