/**
 * Large-document benchmark for the production web build. Each document is
 * dropped onto the running app, as a person would open it, then timed:
 * opening, typing, scrolling, a far jump, Source mode and find.
 *
 *   pnpm --filter sarala-web build && node tests/perf-large.mjs [--only=name] [--assert]
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1427;
const ASSERT = process.argv.includes("--assert");
const ONLY = process.argv.find((a) => a.startsWith("--only="))?.slice(7);

const para = (i) => `Paragraph ${i} has an **emphasised phrase**, some \`inline code\` and a [link](https://example.com/${i}) so it isn't plain text.`;
function mixed(lines) {
  const out = [];
  for (let i = 0; out.length < lines; i++) {
    if (i % 40 === 0) out.push(`## Section ${i / 40}`, "");
    if (i % 17 === 3) out.push("```ts", `const value${i} = ${i};`, "console.log(value" + i + ");", "```", "");
    else if (i % 11 === 2) out.push(`- item ${i}`, `- item ${i + 1}`, `- [ ] task ${i}`, "");
    else if (i % 23 === 7) out.push("| A | B |", "|---|---|", `| ${i} | ${i * 2} |`, "");
    else out.push(para(i), "");
  }
  return out.join("\n");
}
const DOCS = {
  "mixed-5k": () => mixed(5_000),
  "mixed-20k": () => mixed(20_000),
  "mixed-100k": () => mixed(100_000),
  "code-20k": () => ["```ts", ...Array.from({ length: 20_000 }, (_, i) => `export const line${i} = ${i};`), "```"].join("\n"),
  "list-20k": () => Array.from({ length: 20_000 }, (_, i) => `- item number ${i} with some words`).join("\n"),
  "para-20k": () => Array.from({ length: 20_000 }, (_, i) => `one long paragraph line ${i} with no blank between`).join("\n"),
  "table-5k": () => ["| a | b | c |", "|---|---|---|", ...Array.from({ length: 5_000 }, (_, i) => `| ${i} | row | value |`)].join("\n"),
};
// Keys in a single 20,000-item block cost about 60 ms, nearly all of it inside
// the browser's own editing code, so the budget is set to catch regressions.
const BUDGET = { open: 1500, activate: 300, leave: 1500, typeP95: 80, scrollP95: 34, jump: 200, toSource: 400, toLive: 800, find: 300 };

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: new URL("..", import.meta.url).pathname, stdio: "ignore", detached: true });
process.on("exit", () => { try { process.kill(-server.pid); } catch { /* already gone */ } });
await new Promise((r) => setTimeout(r, 2500));
const browser = await chromium.launch({ channel: "chrome", args: ["--enable-precise-memory-info"] });
const STEP_TIMEOUT = 90_000;
const within = (p, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${label}`)), STEP_TIMEOUT))]);
const row = [];

async function run(name, text) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await context.newPage();
  const res = { name, lines: text.split("\n").length, kb: Math.round(text.length / 1024) };
  try {
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector(".block");
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
      window.__long = [];
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ["longtask"] });
    });
    res.open = await within(page.evaluate(async (t) => {
      const data = new DataTransfer();
      data.items.add(new File([t], "big.md", { type: "text/markdown" }));
      const start = performance.now();
      window.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
      while (!/big\.md/.test(document.title)) await new Promise((r) => setTimeout(r, 5));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
      return performance.now() - start;
    }, text), "open");
    res.maxLong = await page.evaluate(() => new Promise((r) => setTimeout(() => r(Math.max(0, ...window.__long)), 800)));
    res.blocks = await page.locator(".block").count();
    res.domNodes = await page.evaluate(() => document.querySelectorAll("*").length);

    // Typing, in the middle of the document.
    await page.evaluate(() => { const s = document.querySelector(".scroll"); s.scrollTop = s.scrollHeight / 2; });
    await page.waitForTimeout(600);
    const box = await page.evaluate(() => {
      const b = [...document.querySelectorAll(".block")].map((e) => e.getBoundingClientRect()).find((r) => r.height > 10 && r.top > 120 && r.top < 700);
      return b ? { x: b.left + 60, y: b.top + Math.min(b.height / 2, 200) } : { x: 700, y: 400 };
    });
    await page.evaluate(() => { window.__mark = performance.now(); });
    await page.mouse.click(box.x, box.y);
    res.activate = await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(performance.now() - window.__mark)))));
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      window.__keys = [];
      document.addEventListener("beforeinput", () => {
        const t = performance.now();
        requestAnimationFrame(() => { const c = new MessageChannel(); c.port1.onmessage = () => window.__keys.push(performance.now() - t); c.port2.postMessage(0); });
      }, true);
    });
    await within(page.keyboard.type("the quick brown fox jumps over the lazy dog ", { delay: 40 }), "typing");
    await page.waitForTimeout(400);
    const keys = (await page.evaluate(() => window.__keys)).sort((a, b) => a - b);
    res.typeP50 = keys[Math.floor(keys.length / 2)] ?? -1;
    res.typeP95 = keys[Math.floor(keys.length * 0.95)] ?? -1;

    // Smooth scrolling: steady wheel-speed motion, measured frame by frame.
    res.leave = await page.evaluate(async () => {
      const start = performance.now();
      document.activeElement?.blur();
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
      return performance.now() - start;
    });
    res.scrollP95 = await within(page.evaluate(async () => {
      const s = document.querySelector(".scroll"); s.scrollTop = 0;
      await new Promise((r) => setTimeout(r, 300));
      const gaps = []; let last = performance.now();
      for (let i = 0; i < 180; i++) {
        s.scrollTop += 120;
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now(); gaps.push(now - last); last = now;
      }
      window.__gaps = gaps;
      return gaps.sort((a, b) => a - b)[Math.floor(gaps.length * 0.95)];
    }), "scroll");
    res.scrollMax = await page.evaluate(() => Math.max(...window.__gaps));

    // A far jump, like dragging the scrollbar: until real content is on screen.
    res.jump = await within(page.evaluate(async () => {
      const s = document.querySelector(".scroll");
      const start = performance.now();
      s.scrollTop = s.scrollHeight * 0.8;
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        const r = s.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(".block");
        if (hit?.textContent.trim()) return performance.now() - start;
        if (performance.now() - start > 5000) return 5000;
      }
    }), "jump");

    const toggle = async (selector) => page.evaluate(async (sel) => {
      const start = performance.now();
      [...document.querySelectorAll(".view-toggle button")].find((b) => b.textContent.trim() === sel).click();
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
      return performance.now() - start;
    }, selector);
    res.toSource = await within(toggle("Source"), "toSource");
    await page.waitForTimeout(300);
    res.toLive = await within(toggle("Live"), "toLive");
    await page.waitForTimeout(300);

    await page.keyboard.press("Control+f");
    await page.waitForSelector(".findbar input");
    res.find = await within(page.evaluate(async () => {
      const input = document.querySelector(".findbar input");
      const start = performance.now();
      input.value = "item"; input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
      return performance.now() - start;
    }), "find");
    res.heapMB = await page.evaluate(() => Math.round(performance.memory.usedJSHeapSize / 1048576));
  } catch (e) {
    res.error = e.message.split("\n")[0].slice(0, 80);
  }
  await context.close().catch(() => {});
  return res;
}

for (const [name, make] of Object.entries(DOCS)) {
  if (ONLY && !name.includes(ONLY)) continue;
  const r = await run(name, make());
  row.push(r);
  const n = (v) => (v === undefined ? "-" : Math.round(v));
  console.log(`${name.padEnd(11)} ${String(r.lines).padStart(7)} lines ${String(r.kb).padStart(5)}KB ${String(r.blocks ?? "-").padStart(6)} blocks ${String(r.domNodes ?? "-").padStart(7)} nodes | open ${n(r.open)} (long ${n(r.maxLong)}) | click ${n(r.activate)} key p50 ${n(r.typeP50)} p95 ${n(r.typeP95)} leave ${n(r.leave)} | scroll p95 ${n(r.scrollP95)} max ${n(r.scrollMax)} | jump ${n(r.jump)} | src ${n(r.toSource)} live ${n(r.toLive)} | find ${n(r.find)} | heap ${n(r.heapMB)}MB${r.error ? ` | ERROR ${r.error}` : ""}`);
}
await browser.close();
let failed = 0;
// 100,000 lines is a stress test, far past what the budgets promise. It's there
// to show how cost grows, and it still has to finish without an error.
if (ASSERT) for (const r of row) {
  if (r.error) { console.log(`FAIL ${r.name}: ${r.error}`); failed++; }
  if (r.name !== "mixed-100k") for (const [k, budget] of Object.entries(BUDGET)) if (r[k] > budget) { console.log(`FAIL ${r.name} ${k} ${Math.round(r[k])} > ${budget}`); failed++; }
}
process.exit(failed ? 1 : 0);
