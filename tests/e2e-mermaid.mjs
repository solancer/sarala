/**
 * Deterministic browser test for src/mermaid.ts: bundle the helper (with real
 * mermaid), drive renderMermaidIn directly in Chromium against placeholder
 * markup like renderMarkdown emits. Covers a valid diagram → SVG, an invalid
 * one → inline error, and the last-good fallback on a broken re-render.
 *
 *   node tests/e2e-mermaid.mjs
 */
import { build } from "esbuild";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, ".build", "mermaid-bundle.js");
await build({
  entryPoints: [path.join(here, "..", "src", "mermaid.ts")],
  bundle: true,
  format: "iife",
  globalName: "MermaidHelper",
  outfile,
});
const bundle = readFileSync(outfile, "utf8");

const browser = await chromium.launch();
const page = await browser.newPage();
let failures = 0;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failures++; };

// Each block renders in its own container with its own key — as Block.tsx does.
await page.setContent(`<!doctype html><html><body>
  <div class="app" style="--mermaid-theme: default">
    <div id="good" class="rendered"><div class="mermaid-block" data-mermaid="graph TD; A--&gt;B; B--&gt;C"></div></div>
    <div id="bad" class="rendered"><div class="mermaid-block" data-mermaid="graph TD; A--&gt;"></div></div>
    <div id="cache" class="rendered"><div class="mermaid-block" data-mermaid="graph TD; X--&gt;Y"></div></div>
  </div>
</body></html>`);
await page.addScriptTag({ content: bundle });
const render = (sel, key) =>
  page.evaluate(([sel, key]) => window.MermaidHelper.renderMermaidIn(document.querySelector(sel), key), [sel, key]);

// Valid diagram → SVG, no error.
await render("#good", "k-good");
await page.waitForTimeout(1500);
check(await page.locator("#good svg").count() > 0, "valid mermaid renders an SVG");
check(await page.locator("#good .render-error").count() === 0, "valid mermaid has no error banner");

// Invalid diagram → inline error, never blank.
await render("#bad", "k-bad");
await page.waitForTimeout(800);
check(await page.locator("#bad .render-error").count() > 0, "invalid mermaid shows an inline error");

// Last-good fallback: render good, then replace with broken source under the
// same key — the prior SVG stays, with an error appended.
await render("#cache", "k-cache");
await page.waitForTimeout(1000);
check(await page.locator("#cache svg").count() > 0, "cache key renders its first good diagram");
await page.evaluate(() => {
  const block = document.querySelector("#cache .mermaid-block");
  block.setAttribute("data-mermaid", "graph TD; Z-->");
  delete block.dataset.rendered;
});
await render("#cache", "k-cache");
await page.waitForTimeout(1000);
const cache = await page.evaluate(() => {
  const n = document.querySelector("#cache .mermaid-block");
  return { hasSvg: !!n.querySelector("svg"), hasError: !!n.querySelector(".render-error") };
});
check(cache.hasSvg && cache.hasError,
  `broken re-render keeps the last good diagram + error (svg:${cache.hasSvg}, err:${cache.hasError})`);

// A spread of diagram types (not just flowchart) renders.
const types = {
  sequence: "sequenceDiagram\n  Alice->>Bob: Hi\n  Bob-->>Alice: Hello",
  pie: 'pie title Pets\n  "Dogs": 3\n  "Cats": 2',
  classDiagram: "classDiagram\n  Animal <|-- Dog",
  state: "stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running",
  gantt: "gantt\n  title T\n  section S\n  A task: a1, 2024-01-01, 3d",
  mindmap: "mindmap\n  root((core))\n    a\n    b",
};
for (const [name, src] of Object.entries(types)) {
  await page.evaluate(([name, src]) => {
    const wrap = document.createElement("div");
    wrap.id = `t-${name}`;
    wrap.className = "rendered";
    const block = document.createElement("div");
    block.className = "mermaid-block";
    block.setAttribute("data-mermaid", src);
    wrap.appendChild(block);
    document.querySelector(".app").appendChild(wrap);
    return window.MermaidHelper.renderMermaidIn(wrap, `k-${name}`);
  }, [name, src]);
  await page.waitForTimeout(700);
  const ok = await page.locator(`#t-${name} svg`).count() > 0
    && await page.locator(`#t-${name} .render-error`).count() === 0;
  check(ok, `${name} diagram renders`);
}

await browser.close();
console.log(failures ? `\n${failures} FAILURES` : "\nall mermaid checks passed");
process.exit(failures ? 1 : 0);
