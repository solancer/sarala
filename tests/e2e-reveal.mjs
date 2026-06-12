/**
 * Live-app check of caret-scoped marker reveal: real Vite dev server, real
 * Chromium, real Solid effects and selectionchange listeners.
 *
 *   node tests/e2e-reveal.mjs   (starts its own server on :1421)
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1421;
const server = spawn("npx", ["vite", "--port", String(PORT)], { stdio: "pipe" });
const kill = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", kill);

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("vite did not start")), 20000);
  server.stdout.on("data", (d) => {
    if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); }
  });
  server.stderr.on("data", (d) => process.stderr.write(d));
});

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") console.log(`[page ${m.type()}]`, m.text());
});
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

// Activate the paragraph containing "*is*" by clicking its rendered view
// near the start of the text (away from the italic token at the end).
const para = page.locator(".block .rendered", { hasText: "Split panes duplicate" });
await para.click({ position: { x: 30, y: 12 } });
await page.waitForSelector(".block.active .source");

const state = () =>
  page.evaluate(() => {
    const el = document.querySelector(".block.active .source");
    const sel = window.getSelection();
    const pre = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
    let caret = -1;
    if (pre && el.contains(pre.startContainer)) {
      pre.selectNodeContents(el);
      pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
      caret = pre.toString().length;
    }
    return {
      text: el.textContent,
      caret,
      toks: [...el.querySelectorAll(".md-tok")].map((t) => ({
        on: t.classList.contains("md-on"),
        markDisplay: getComputedStyle(t.querySelector(".md-mark")).display,
        sample: t.textContent.slice(0, 12),
      })),
    };
  });

let s = await state();
check(s.text.includes("*is*"), `active block holds the markdown source (caret@${s.caret})`);
const isTok = () => s.toks.find((t) => t.sample === "*is*");
check(!!isTok(), "italic *is* token exists");
check(isTok() && !isTok().on && isTok().markDisplay === "none",
  `caret away from token → markers hidden (display:${isTok()?.markDisplay})`);

// Move the caret inside *is* purely via selection (exercises selectionchange).
await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  const target = el.textContent.indexOf("*is*") + 2;
  let remaining = target;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (remaining <= node.data.length) {
      const range = document.createRange();
      range.setStart(node, remaining);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    remaining -= node.data.length;
  }
});
await page.waitForTimeout(120); // let selectionchange run
s = await state();
check(isTok() && isTok().on && isTok().markDisplay === "inline",
  `caret inside token → markers revealed (display:${isTok()?.markDisplay})`);

// Arrow out of the token: markers must hide again without re-render.
for (let i = 0; i < 8; i++) await page.keyboard.press("ArrowRight");
await page.waitForTimeout(120);
s = await state();
check(isTok() && !isTok().on && isTok().markDisplay === "none",
  `arrowed past token → markers hidden again (display:${isTok()?.markDisplay})`);

// Heading: a re-entered heading stays looking rendered — hashes hidden while
// the caret is in the text, revealed only at/inside the prefix.
await page.locator(".block .rendered", { hasText: "Why no preview window" }).click();
await page.waitForSelector(".block.active .source");
await page.waitForTimeout(120);
const heading = await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  const tok = el.querySelector(".md-tok.md-pre");
  return {
    on: tok.classList.contains("md-on"),
    display: getComputedStyle(tok.querySelector(".md-mark")).display,
  };
});
check(!heading.on && heading.display === "none",
  "heading: caret in the text keeps ## hidden (block looks rendered)");

// List block: markers hidden with rendered-looking stand-ins.
await page.locator(".block .rendered", { hasText: "Task lists with clickable" }).click();
await page.waitForSelector(".block.active .source");
await page.waitForTimeout(120);
const list = await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  const toks = [...el.querySelectorAll(".md-tok.md-pre")];
  const bullet = toks.find((t) => t.classList.contains("md-bullet"));
  const done = toks.find((t) => t.classList.contains("md-done"));
  return {
    prefixes: toks.length,
    revealed: toks.filter((t) => t.classList.contains("md-on")).length,
    bulletBefore: bullet ? getComputedStyle(bullet, "::before").content : null,
    doneBefore: done ? getComputedStyle(done, "::before").content : null,
  };
});
check(list.prefixes >= 5, `list block tokenized ${list.prefixes} prefixes`);
check(list.revealed <= 1, `at most the caret line's marker is revealed (${list.revealed})`);
check(list.bulletBefore === '"•"', `hidden bullet shows • stand-in (got ${list.bulletBefore})`);
check(list.doneBefore === '"☑"', `checked task shows ☑ stand-in (got ${list.doneBefore})`);

// Table block: active table renders as a real grid, pipes and separator
// concealed, textContent still byte-identical to the source.
await page.locator(".block .rendered", { hasText: "Cmd/Ctrl+S" }).click();
await page.waitForSelector(".block.active .source");
await page.waitForTimeout(120);
const table = await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  const t = el.querySelector(".md-table");
  return {
    sourceText: el.textContent.startsWith("| Shortcut | Action |"),
    display: t ? getComputedStyle(t).display : null,
    pipeDisplay: t ? getComputedStyle(t.querySelector(".md-pipe")).display : null,
    sepDisplay: t ? getComputedStyle(t.querySelector(".md-tsep")).display : null,
    cellDisplay: t ? getComputedStyle(t.querySelector(".md-tcell")).display : null,
    headerWeight: t ? getComputedStyle(t.querySelector(".md-tcell")).fontWeight : null,
  };
});
check(table.sourceText, "active table block still holds raw pipe source as text");
check(table.display === "table", `table lays out as a grid (display:${table.display})`);
check(table.cellDisplay === "table-cell", `cells are table cells (display:${table.cellDisplay})`);
check(table.pipeDisplay === "none", `pipes concealed (display:${table.pipeDisplay})`);
check(table.sepDisplay === "none", `separator row concealed (display:${table.sepDisplay})`);
check(table.headerWeight === "600", `header row bold (weight:${table.headerWeight})`);

// Typing in a cell survives the re-style round trip and keeps the grid.
await page.keyboard.type("XYZ");
await page.waitForTimeout(150);
const afterType = await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  const t = el.querySelector(".md-table");
  return {
    hasTyped: el.textContent.includes("XYZ"),
    stillTable: t ? getComputedStyle(t).display : null,
  };
});
check(afterType.hasTyped, "typed text lands in the table source");
check(afterType.stillTable === "table", "grid layout survives typing re-styles");

await browser.close();
kill();
console.log(failures ? `\n${failures} FAILURES` : "\nall live-app checks passed");
process.exit(failures ? 1 : 0);
