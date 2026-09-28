/**
 * Rendering performance benchmark. Loads the Kafka fixture (tables, Mermaid,
 * math, code, footnotes) into the browser build and times the interactions
 * that must feel instant: tab switches, table row/column moves, block moves,
 * and typing. Each timing covers the synchronous update plus two animation
 * frames, so style/layout/paint are included.
 *
 *   node tests/perf-render.mjs            # print timings
 *   node tests/perf-render.mjs --assert   # also fail on budget regressions
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const ASSERT = process.argv.includes("--assert");
// Budgets in ms (median). Generous enough for CI jitter, tight enough to catch
// a regression back to whole-document re-rendering.
const BUDGET = { themeSwitch: 150, toSource: 120, toLive: 200, sourceTyping: 60, findKey: 50, switchTab: 120, tableRow: 40, tableCol: 40, tableTyping: 40, activate: 60, blockMove: 40, typing: 30 };

const SCALE = Number(process.argv.find((a) => a.startsWith("--scale="))?.slice(8) ?? 1);
const fixture = await readFile(new URL("./fixtures/kafka-guide.md", import.meta.url), "utf8");
// --scale=N repeats the body N times to probe how cost grows with document size.
const kafka = [fixture, ...Array.from({ length: SCALE - 1 }, () => fixture.replace(/^---[\s\S]*?\n---\n/, ""))].join("\n\n");
const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
const port = 1437;
const server = spawn("node", ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"], { stdio: "pipe" });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Vite startup timed out")), 20000);
    server.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); } });
    server.stderr.on("data", (d) => process.stderr.write(d));
    server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Vite exited: ${code}`)); });
  });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.goto(`http://localhost:${port}`);
  await page.waitForSelector('[role="tab"]');

  const results = await page.evaluate(async ({ kafka, readme }) => {
    const store = await import("/src/store.ts");
    const { executeCommand } = await import("/src/commands.ts");
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const settled = async () => {
      const t0 = performance.now();
      while (performance.now() - t0 < 30000) {
        const pending = document.querySelectorAll(".rendered .mermaid-block:not([data-rendered='1'])").length;
        if (!pending) break;
        await new Promise((r) => setTimeout(r, 16));
      }
    };
    const scripting = {};
    let bucket = null;
    const time = async (fn) => {
      const t0 = performance.now(); fn(); const t1 = performance.now();
      if (bucket) (scripting[bucket] ??= []).push(t1 - t0);
      await frames(); return performance.now() - t0;
    };
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const out = {};

    // Warm up lazy modules (Shiki, Mermaid) so first-use import cost isn't counted.
    let t0 = performance.now();
    const kafkaTab = store.openDocument(kafka, "/bench/kafka-guide.md");
    await frames();
    out.openSync = performance.now() - t0;
    await settled();
    // Lazily loaded render data (KaTeX, grammars, emoji) must arrive and
    // re-render the blocks that use it.
    for (let i = 0; i < 200; i++) {
      const done = document.querySelector(".rendered .katex") && document.querySelector(".rendered pre.shiki span[style*='color']")
        && [...document.querySelectorAll(".rendered .emoji")].some((e) => e.textContent === "🚀");
      if (done) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    out.lazyReady = performance.now() - t0;
    if (!document.querySelector(".rendered .katex")) throw new Error("math never rendered");
    if (!document.querySelector(".rendered pre.shiki span[style*='color']")) throw new Error("code never highlighted");
    if (![...document.querySelectorAll(".rendered .emoji")].some((e) => e.textContent === "🚀")) throw new Error("emoji never rendered");
    out.openSettled = performance.now() - t0;
    const readmeTab = store.openDocument(readme, "/bench/README.md");
    await frames(); await settled();
    store.switchTab(kafkaTab); await frames(); await settled();

    const switches = [];
    const settles = [];
    for (let i = 0; i < 6; i++) {
      const target = i % 2 ? kafkaTab : readmeTab;
      const s0 = performance.now();
      bucket = "switchTab";
      switches.push(await time(() => store.switchTab(target)));
      await settled();
      if (target === kafkaTab) settles.push(performance.now() - s0);
    }
    out.switchTab = median(switches);
    out.switchTabSettled = median(settles);
    if (store.activeTabId() !== kafkaTab) { store.switchTab(kafkaTab); await frames(); await settled(); }

    const findBlock = (prefix) => store.doc.blocks.findIndex((b) => b.text.startsWith(prefix));
    const tableIdx = findBlock("| Metric (JMX)");
    // Caret in the first body row (header and delimiter rows don't move).
    const tableText = store.doc.blocks[tableIdx].text;
    store.requestCaret(tableText.indexOf("\n", tableText.indexOf("\n") + 1) + 3);
    store.setActive(tableIdx); await frames();
    const before = store.doc.blocks[tableIdx].text;
    const rows = [], cols = [];
    bucket = "tableRow";
    for (let i = 0; i < 6; i++) {
      rows.push(await time(() => executeCommand(i % 2 ? "paragraph.table.move_row_up" : "paragraph.table.move_row_down")));
      if (i === 0 && store.doc.blocks[tableIdx].text === before) throw new Error("table row move was a no-op");
    }
    bucket = "tableCol";
    for (let i = 0; i < 6; i++) cols.push(await time(() => executeCommand(i % 2 ? "paragraph.table.move_col_left" : "paragraph.table.move_col_right")));
    out.tableRow = median(rows);
    out.tableCol = median(cols);

    // Typing inside the active table: the live styler re-styles the whole table.
    const tableTyping = [];
    bucket = "tableTyping";
    for (let i = 0; i < 6; i++) {
      const idx = store.doc.activeIndex, text = store.doc.blocks[idx].text, at = text.indexOf("|", text.lastIndexOf("\n")) + 2;
      store.requestCaret(at + 1);
      tableTyping.push(await time(() => store.updateBlock(idx, text.slice(0, at) + "x" + text.slice(at))));
    }
    out.tableTyping = median(tableTyping);

    // Click-to-edit: activating a big table, a long code block, and a diagram.
    const activations = [];
    bucket = "activate";
    for (const prefix of ["| Config | Broker", "```java\nProperties props", "```mermaid\nsequenceDiagram\n    autonumber"]) {
      store.setActive(-1); await frames();
      const at = findBlock(prefix);
      if (at < 0) throw new Error(`missing block ${prefix}`);
      activations.push(await time(() => store.setActive(at)));
    }
    out.activate = Math.max(...activations);
    store.setActive(-1); await frames();

    const paraIdx = findBlock("Before Kafka, most organisations");
    store.setActive(-1); await frames();
    const moves = [];
    bucket = "blockMove";
    for (let i = 0; i < 6; i++) {
      const at = findBlock("Before Kafka, most organisations");
      moves.push(await time(() => store.moveBlock(at, i % 2 ? -1 : 1)));
    }
    out.blockMove = median(moves);

    store.requestCaret(0); store.setActive(paraIdx); await frames();
    const typing = [];
    bucket = "typing";
    for (let i = 0; i < 8; i++) {
      const idx = store.doc.activeIndex;
      const text = store.doc.blocks[idx].text;
      typing.push(await time(() => store.updateBlock(idx, text + "x")));
    }
    out.typing = median(typing);
    // Theme switch: CSS variables flip; diagrams must re-render in the new theme.
    bucket = "themeSwitch";
    const themeTimes = [];
    for (const id of ["night", "sarala"]) themeTimes.push(await time(() => executeCommand(`themes.set.${id}`)));
    out.themeSwitch = median(themeTimes);
    await settled();

    // Source mode round trip (whole document as one textarea and back).
    store.setActive(-1); await frames();
    bucket = "toSource";
    out.toSource = await time(() => executeCommand("view.source_mode"));
    // Typing in source mode: each keystroke re-splits the whole document.
    const area = document.querySelector(".source-full");
    const sourceKeys = [];
    bucket = "sourceTyping";
    for (let i = 0; i < 6; i++) {
      sourceKeys.push(await time(() => { area.value = area.value.replace("Why Kafka exists", `Why Kafka exists${i}`); area.dispatchEvent(new Event("input", { bubbles: true })); }));
    }
    out.sourceTyping = median(sourceKeys);
    bucket = "toLive";
    out.toLive = await time(() => executeCommand("view.source_mode"));
    await settled();

    // Find as you type: each keystroke re-searches and repaints highlights.
    executeCommand("edit.find"); await frames();
    const input = document.querySelector(".findbar input");
    const findKeys = [];
    bucket = "findKey";
    let query = "";
    for (const ch of "partition") {
      query += ch;
      findKeys.push(await time(() => { input.value = query; input.dispatchEvent(new Event("input", { bubbles: true })); }));
    }
    out.findKey = median(findKeys);
    out.findMatches = document.querySelector(".findbar")?.textContent.match(/(\d+)\s*(?:of|\/)\s*(\d+)/)?.[2] ?? "?";
    executeCommand("edit.find"); await frames();

    for (const [k, xs] of Object.entries(scripting)) out[`${k} (script)`] = median(xs);
    out.blocks = store.doc.blocks.length;
    out.diagrams = document.querySelectorAll(".mermaid-block svg").length;
    return out;
  }, { kafka, readme });

  const fmt = (n) => `${n.toFixed(1).padStart(8)} ms`;
  console.log(`Kafka fixture: ${results.blocks} blocks, ${results.diagrams} rendered diagrams, ${results.findMatches} find matches`);
  for (const [k, v] of Object.entries(results)) if (!["blocks", "diagrams", "findMatches"].includes(k)) console.log(`${k.padEnd(18)}${fmt(v)}${BUDGET[k] ? `   (budget ${BUDGET[k]} ms)` : ""}`);
  if (ASSERT) for (const [k, budget] of Object.entries(BUDGET)) assert.ok(results[k] <= budget, `${k} took ${results[k].toFixed(1)} ms (budget ${budget} ms)`);
} finally { await browser?.close(); server.kill("SIGTERM"); }
