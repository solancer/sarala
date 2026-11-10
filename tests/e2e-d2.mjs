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
  </div>
  <script src="/d2-bundle.js"></script>
</body></html>`;
const server = createServer((req, res) =>
  req.url === "/d2-bundle.js"
    ? res.writeHead(200, { "content-type": "text/javascript" }).end(bundle)
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

  await browser.close();
}

server.close();
if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall d2 checks passed");
