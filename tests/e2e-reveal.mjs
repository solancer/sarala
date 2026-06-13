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

// Syntax highlighting: the welcome doc's rust code block highlights via Shiki
// (loads async; re-renders on ready). Colored token spans must appear.
let shikiSpans = 0;
for (let i = 0; i < 40; i++) {
  shikiSpans = await page.evaluate(() => {
    const pre = document.querySelector(".rendered pre.shiki");
    return pre ? pre.querySelectorAll("span[style*='color']").length : 0;
  });
  if (shikiSpans > 0) break;
  await page.waitForTimeout(250);
}
check(shikiSpans > 5, `Shiki highlights the code block (${shikiSpans} colored tokens)`);

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
    doneBg: done ? getComputedStyle(done, "::before").backgroundColor : null,
    doneBorder: done ? getComputedStyle(done, "::before").borderRadius : null,
  };
});
check(list.prefixes >= 5, `list block tokenized ${list.prefixes} prefixes`);
check(list.revealed <= 1, `at most the caret line's marker is revealed (${list.revealed})`);
check(list.bulletBefore === '"•"', `hidden bullet shows • stand-in (got ${list.bulletBefore})`);
check(list.doneBg !== null && list.doneBg !== "rgba(0, 0, 0, 0)" && list.doneBorder === "3px",
  `checked task draws the filled checkbox stand-in (bg ${list.doneBg}, radius ${list.doneBorder})`);

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

// Table toolbar: floats above the active table; align + resize work and
// keep the block active (mousedown on the toolbar must not blur it).
check(await page.locator(".block.active .table-toolbar").isVisible(), "table toolbar appears");
await page.locator(".table-toolbar .tt-btn[title='Align column center']").click();
await page.waitForTimeout(120);
const aligned = await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  return { sep: el?.textContent.split("\n")[1] ?? "", active: !!el };
});
check(aligned.active, "block stays active after toolbar click");
check(aligned.sep.includes(":---:"), `align-center rewrites the separator (${aligned.sep.trim()})`);

await page.locator(".table-toolbar .tt-btn[title='Resize table']").click();
check(await page.locator(".tt-popover").isVisible(), "resize popover opens");
const beforeRows = await page.evaluate(
  () => document.querySelector(".block.active .source").textContent.split("\n").length
);
// Click the grid cell for 2 columns x 6 total rows (row index 5, col index 1).
await page.locator(".tt-grid .tt-cell").nth(5 * 8 + 1).click();
await page.waitForTimeout(150);
const afterResize = await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  return {
    lines: el.textContent.split("\n").length,
    stillTable: !!el.querySelector(".md-table"),
    hasOld: el.textContent.includes("Save"),
  };
});
check(afterResize.lines === 7, `grid pick resizes to 6 rows + separator = 7 lines (was ${beforeRows}, now ${afterResize.lines})`);
check(afterResize.stillTable, "resized table still renders as a grid");
check(afterResize.hasOld, "existing cells survive the resize");

// Zero-jank activation: opening any block type must not shift the layout
// below it (Typora behavior). Reload first to discard earlier edits.
await page.reload();
await page.waitForSelector(".block");
const JANK_TARGETS = [
  ["h1", "Welcome to Inkdown"],
  ["paragraph", "Split panes duplicate"],
  ["h2", "Why no preview window"],
  ["h3", "highlighted the same"],
  ["list", "Task lists with clickable"],
  ["quote", "publishable as-is"],
  ["fence", "tauri::command"],
  ["table", "Cmd/Ctrl+S"],
];
for (const [label, text] of JANK_TARGETS) {
  // Document-relative position: compensate for the .scroll container's
  // scroll offset (focusing a below-the-fold block scrolls it into view).
  const lastBlockY = () => page.evaluate(() => {
    const blocks = document.querySelectorAll(".block");
    const scroller = document.querySelector(".scroll");
    return blocks[blocks.length - 1].getBoundingClientRect().top + scroller.scrollTop;
  });
  const before = await lastBlockY();
  await page.locator(".block:not(.active) .rendered", { hasText: text }).first().click();
  await page.waitForTimeout(120);
  const shift = Math.abs((await lastBlockY()) - before);
  check(shift < 1, `${label}: activation shifts layout below by ${shift.toFixed(1)}px (<1px)`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
}

// Tab cycles table cells, selecting each cell's content; the toolbar's
// width toggle stretches the table to the page column.
await page.reload();
await page.waitForSelector(".block");
await page.locator(".block .rendered", { hasText: "Cmd/Ctrl+S" }).click({ position: { x: 30, y: 12 } });
await page.waitForSelector(".block.active .source .md-table");
// Park the caret deterministically inside the first header cell ("Shortcut").
await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let remaining = 2;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (remaining <= n.data.length) {
      const r = document.createRange();
      r.setStart(n, remaining);
      r.collapse(true);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
      return;
    }
    remaining -= n.data.length;
  }
});
await page.waitForTimeout(80);
const selected = () => page.evaluate(() => window.getSelection().toString());
await page.keyboard.press("Tab");
check((await selected()) === "Action", `Tab selects the next cell ("${await selected()}")`);
await page.keyboard.press("Tab");
check((await selected()) === "Cmd/Ctrl+S", "Tab wraps from the row's last column to the next row");
await page.keyboard.press("Shift+Tab");
check((await selected()) === "Action", "Shift+Tab goes back a cell");
for (let i = 0; i < 7; i++) await page.keyboard.press("Tab");
check((await selected()) === "Shortcut", "Tab cycles from the table's end back to the first cell");

const tableWidth = () =>
  page.evaluate(() => document.querySelector(".block.active .md-table").getBoundingClientRect().width);
const narrow = await tableWidth();
await page.locator(".table-toolbar .tt-btn[title='Full width']").click();
await page.waitForTimeout(120);
const wide = await tableWidth();
check(wide > narrow + 100, `full-width toggle stretches the table (${narrow.toFixed(0)} → ${wide.toFixed(0)}px)`);
await page.locator(".table-toolbar .tt-btn[title='Default width']").click();
await page.waitForTimeout(120);
check(Math.abs((await tableWidth()) - narrow) < 2, "toggling back restores content width");
await page.keyboard.press("Escape");

// Code block language picker: a quiet badge expands into a filterable
// dropdown that rewrites the fence line.
await page.locator(".block .rendered", { hasText: "tauri::command" }).click();
await page.waitForSelector(".block.active .code-lang .cl-badge");
check((await page.locator(".cl-badge").textContent()) === "rust",
  "badge shows the fence's current language");
await page.locator(".cl-badge").click();
await page.waitForSelector(".code-lang input");
await page.locator(".code-lang input").fill("py");
await page.waitForTimeout(80);
await page.locator(".code-lang li", { hasText: "python" }).first().click();
await page.waitForTimeout(150);
const fence = await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  return { firstLine: el?.textContent.split("\n")[0], active: !!el };
});
check(fence.active, "block stays active after picking a language");
check(fence.firstLine === "```python", `fence line rewritten (${JSON.stringify(fence.firstLine)})`);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);

// Find: all matches highlighted, Enter cycles with focus staying in the
// input, no block ever activates from searching.
await page.keyboard.press("Control+f");
await page.waitForSelector(".findbar input");
await page.locator(".findbar input").first().fill("markdown");
await page.waitForTimeout(150);
const findState = () =>
  page.evaluate(() => ({
    count: document.querySelector(".findbar-count")?.textContent,
    highlights: CSS.highlights?.get("inkdown-find")?.size ?? -1,
    current: CSS.highlights?.get("inkdown-find-current")?.size ?? -1,
    inputFocused: document.activeElement === document.querySelector(".findbar input"),
    anyActive: !!document.querySelector(".block.active"),
  }));
let fs = await findState();
check(fs.highlights >= 3, `all matches highlighted (${fs.highlights})`);
check(fs.current === 1, "current match has its own highlight");
check(fs.count?.startsWith("1 of"), `count shows position (${fs.count})`);
check(!fs.anyActive, "searching does not activate any block");
await page.keyboard.press("Enter");
await page.waitForTimeout(100);
fs = await findState();
check(fs.count?.startsWith("2 of"), `Enter advances to the next match (${fs.count})`);
check(fs.inputFocused, "focus stays in the search input after Enter");
const total = fs.highlights;
for (let i = 0; i < total - 1; i++) await page.keyboard.press("Enter");
await page.waitForTimeout(100);
fs = await findState();
check(fs.count?.startsWith("1 of"), `Enter wraps around the match list (${fs.count})`);
await page.keyboard.press("Escape");
await page.waitForTimeout(100);
check((await page.evaluate(() => CSS.highlights?.get("inkdown-find")?.size ?? 0)) === 0,
  "closing the find bar clears the highlights");

// Sidebar resize: dragging the handle changes the width within clamps.
await page.reload();
await page.waitForSelector(".sidebar");
const sidebarW = () => page.evaluate(() => document.querySelector(".sidebar").getBoundingClientRect().width);
const startW = await sidebarW();
const handle = await page.locator(".sidebar-resize").boundingBox();
await page.mouse.move(handle.x + 3, handle.y + 200);
await page.mouse.down();
await page.mouse.move(handle.x + 90, handle.y + 200, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(80);
const widerW = await sidebarW();
check(Math.abs(widerW - (startW + 90)) < 8, `drag widens the sidebar (${startW} → ${widerW})`);
// Clamp: dragging far left stops at the 180px minimum.
const h2 = await page.locator(".sidebar-resize").boundingBox();
await page.mouse.move(h2.x + 3, h2.y + 200);
await page.mouse.down();
await page.mouse.move(20, h2.y + 200, { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(80);
check((await sidebarW()) === 180, `drag clamps to the 180px minimum (${await sidebarW()})`);

// Clicking the gutter beside a line activates THAT line and never jumps the
// viewport to the bottom (regression: empty-space clicks targeted the last
// block and scrolled the page away).
await page.reload();
await page.waitForSelector(".block");
await page.evaluate(() => document.querySelector(".scroll").scrollTo({ top: 0 }));
await page.waitForTimeout(80);
const scrollTop = () => page.evaluate(() => document.querySelector(".scroll").scrollTop);
const before = await scrollTop();
// Click in the left gutter (.page padding) at the first heading's Y.
const welcomeBox = await page.locator(".block", { hasText: "Welcome to Inkdown" }).first().boundingBox();
const pageBox = await page.locator(".page").boundingBox();
await page.mouse.click(pageBox.x + 20, welcomeBox.y + welcomeBox.height / 2);
await page.waitForTimeout(120);
const gutter = await page.evaluate(() => ({
  active: document.querySelector(".block.active .source")?.textContent ?? null,
  scroll: document.querySelector(".scroll").scrollTop,
}));
check(Math.abs(gutter.scroll - before) < 5, `gutter click keeps the viewport put (${before} → ${gutter.scroll})`);
check(gutter.active?.includes("Welcome to Inkdown"),
  `gutter click activates the nearest block, not the last (${JSON.stringify(gutter.active?.slice(0, 20))})`);
await page.keyboard.press("Escape");
await page.waitForTimeout(80);

// Regression: typing "# " must leave the caret after the space, not jump to
// offset 0 (the whole line is a display:none marker until revealed).
await page.reload();
await page.waitForSelector(".block");
await page.locator(".block").last().locator(".rendered").click();
await page.waitForSelector(".block.active .source");
await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
});
await page.keyboard.press("Enter");
await page.waitForTimeout(150);
await page.keyboard.type("#");
await page.waitForTimeout(80);
await page.keyboard.type(" ");
await page.waitForTimeout(120);
const hashCaret = await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  const sel = getSelection();
  const pre = sel.getRangeAt(0).cloneRange();
  pre.selectNodeContents(el);
  pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
  return { caret: pre.toString().length, text: el.textContent };
});
check(hashCaret.text === "# " && hashCaret.caret === 2,
  `caret stays after "# " (text=${JSON.stringify(hashCaret.text)}, caret=${hashCaret.caret})`);
await page.keyboard.press("Escape");
await page.waitForTimeout(80);

// Dead-key layouts: the backtick/tilde key composes (key="Dead",
// code="Backquote") instead of inserting, so code fences can't be typed.
// The handler must insert a literal backtick so ``` forms a code block.
await page.locator(".block").last().locator(".rendered").click();
await page.waitForSelector(".block.active .source");
await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  const s = getSelection();
  s.removeAllRanges();
  s.addRange(r);
});
await page.keyboard.press("Enter");
await page.waitForTimeout(120);
for (let i = 0; i < 3; i++) {
  await page.evaluate(() =>
    document.querySelector(".block.active .source").dispatchEvent(
      new KeyboardEvent("keydown", { key: "Dead", code: "Backquote", bubbles: true, cancelable: true })
    )
  );
  await page.waitForTimeout(80);
}
const deadKeyFence = await page.evaluate(() => {
  const el = document.querySelector(".block.active .source");
  return { text: el?.textContent, code: el?.classList.contains("code-block") };
});
check(deadKeyFence.text === "```" && deadKeyFence.code,
  `dead-key backtick inserts a literal backtick → code fence (text=${JSON.stringify(deadKeyFence.text)})`);
await page.keyboard.press("Escape");
await page.waitForTimeout(80);

// Undo / redo: typing coalesces into one step; Cmd/Ctrl+Z round-trips.
await page.locator(".block .rendered", { hasText: "Split panes duplicate" }).first().click();
await page.waitForSelector(".block.active .source");
await page.keyboard.type("QQQ");
await page.waitForTimeout(200);
const hasQQQ = () => page.evaluate(() => document.querySelector(".page").textContent.includes("QQQ"));
check(await hasQQQ(), "typed text lands in the document");
await page.keyboard.press("Control+z");
await page.waitForTimeout(120);
check(!(await hasQQQ()), "one undo removes the whole typing burst (coalesced)");
await page.keyboard.press("Control+Shift+z");
await page.waitForTimeout(120);
check(await hasQQQ(), "redo restores it");
await page.keyboard.press("Control+z");
await page.waitForTimeout(120);
check(!(await hasQQQ()), "undo works again after redo");
await page.keyboard.press("Escape");
await page.waitForTimeout(80);

// Within-block stability: the text itself must not move when its block
// activates (code pills, checkboxes, and heading tracking once did).
const textX = (needle) =>
  page.evaluate((needle) => {
    const walker = document.createTreeWalker(document.querySelector(".page"), NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const i = n.data.indexOf(needle);
      if (i !== -1) {
        const r = document.createRange();
        r.setStart(n, i);
        r.setEnd(n, i + needle.length);
        return r.getBoundingClientRect().x;
      }
    }
    return null;
  }, needle);
for (const [label, blockText, needle] of [
  ["task line", "Task lists with clickable", "try checking"],
  ["code pill line", "Task lists with clickable", "italic,"],
  ["heading text", "Why no preview window", "no preview"],
]) {
  const before = await textX(needle);
  await page.locator(".block:not(.active) .rendered", { hasText: blockText }).first().click({ position: { x: 400, y: 12 } });
  await page.waitForTimeout(120);
  const delta = Math.abs((await textX(needle)) - before);
  check(delta < 1, `${label}: text shifts ${delta.toFixed(1)}px on activation (<1px)`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
}

// Arrow-key navigation: line by line through wrapped paragraphs, leaving a
// block only from its first/last VISUAL line, entering the next at its start.
await page.setViewportSize({ width: 900, height: 800 }); // force the paragraph to wrap
await page.reload();
await page.waitForSelector(".block");
await page.locator(".block .rendered", { hasText: "Split panes duplicate" }).click({ position: { x: 30, y: 12 } });
await page.waitForSelector(".block.active .source");
const caretState = () =>
  page.evaluate(() => {
    const el = document.querySelector(".block.active .source");
    if (!el) return null;
    const sel = window.getSelection();
    const pre = sel.getRangeAt(0).cloneRange();
    pre.selectNodeContents(el);
    pre.setEnd(sel.getRangeAt(0).startContainer, sel.getRangeAt(0).startOffset);
    return { text: el.textContent, caret: pre.toString().length };
  });

let nav = await caretState();
check(nav && nav.text.startsWith("Split panes") && nav.caret < 30,
  `caret starts near the top of the wrapped paragraph (@${nav?.caret})`);
// Walk down one visual line at a time until the block changes; a wrapped
// paragraph must take several presses (no instant jump to the next block).
let downs = 0;
while (downs < 8) {
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(80);
  downs++;
  nav = await caretState();
  if (!nav.text.startsWith("Split panes")) break;
}
check(downs >= 2, `wrapped paragraph takes ${downs} ArrowDowns to leave (>= 2 — line by line, no jump)`);
check(nav && nav.text.startsWith("## What works") && nav.caret === 0,
  `ArrowDown enters the next block at its START (@${nav?.caret} in ${JSON.stringify(nav?.text.slice(0, 16))})`);
await page.keyboard.press("ArrowUp");
await page.waitForTimeout(120);
nav = await caretState();
check(nav && nav.text.startsWith("Split panes") && nav.caret === nav.text.length,
  "ArrowUp from a block's first line arrives at the END of the previous block");

// Math: renders KaTeX in the inactive block, shows raw source when active.
await page.reload();
await page.waitForSelector(".block");
await page.locator(".block .rendered", { hasText: "Split panes duplicate" }).first().click();
await page.waitForSelector(".block.active .source");
await page.keyboard.press("End");
await page.keyboard.type(" energy $E=mc^2$ here");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const mathBlock = page.locator(".block .rendered", { hasText: "energy" }).first();
check(await mathBlock.locator(".katex").count() > 0, "inline math renders KaTeX in the inactive block");
await mathBlock.click();
await page.waitForSelector(".block.active .source");
check((await page.locator(".block.active .source").textContent())?.includes("$E=mc^2$"),
  "active block shows the raw math source");
await page.keyboard.press("Escape");
await page.waitForTimeout(100);

// Image render path (stash → DOMPurify → src re-injection). A data-URI image
// passes the resolver through and must appear as a loaded <img>.
const DATA_URI = "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==";
await page.locator(".block .rendered", { hasText: "Split panes duplicate" }).first().click();
await page.waitForSelector(".block.active .source");
await page.keyboard.press("End");
await page.evaluate((uri) => {
  const el = document.querySelector(".block.active .source");
  const dt = new DataTransfer();
  dt.setData("text/plain", ` ![dot](${uri})`);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, DATA_URI);
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
const imgInfo = await page.evaluate(() => {
  const img = document.querySelector(".block .rendered img");
  return img ? { src: img.getAttribute("src"), alt: img.getAttribute("alt") } : null;
});
check(imgInfo?.src?.startsWith("data:image/gif"), `image renders with its src re-injected (${imgInfo?.src?.slice(0, 20)})`);
check(imgInfo?.alt === "dot", "image keeps its alt text");
// Image context menu: right-click the rendered image → Switch Syntax + Zoom
// rewrite the source (file ops need Tauri, so only these are exercised here).
const rightClickImage = async () => {
  // Dispatch contextmenu directly (a 1x1 data-URI image is too small for a
  // reliable pointer right-click); fixed on-screen coords keep the menu in view.
  await page.locator(".block .rendered img").first().scrollIntoViewIfNeeded();
  await page.evaluate(() => {
    const img = document.querySelector(".block .rendered img");
    img.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, cancelable: true, clientX: 400, clientY: 300,
    }));
  });
  await page.waitForSelector(".img-menu");
};
await rightClickImage();
check(await page.locator(".img-menu").isVisible(), "right-click an image opens the context menu");
// Read a block's raw source by briefly activating it.
const blockSource = async (needle) => {
  await page.locator(".block .rendered", { hasText: needle }).first().click();
  await page.waitForSelector(".block.active .source");
  const src = (await page.locator(".block.active .source").textContent()) ?? "";
  await page.keyboard.press("Escape");
  await page.waitForTimeout(80);
  return src;
};
// Switch to HTML.
await page.locator(".im-parent", { hasText: "Switch Image Syntax" }).hover();
await page.locator(".im-item", { hasText: "HTML" }).click();
await page.waitForTimeout(150);
check((await blockSource("Split panes")).includes("<img"), "Switch to HTML rewrites the image to an <img> tag");
// Zoom 50% (re-open menu on the now-HTML image).
await rightClickImage();
await page.locator(".im-parent", { hasText: "Zoom Image" }).hover();
await page.locator(".im-item", { hasText: /^50%$/ }).click();
await page.waitForTimeout(150);
check((await blockSource("Split panes")).includes("zoom: 50%"), "Zoom 50% adds a zoom style to the image");
// Switch back to Markdown.
await rightClickImage();
await page.locator(".im-parent", { hasText: "Switch Image Syntax" }).hover();
await page.locator(".im-item", { hasText: "Markdown" }).click();
await page.waitForTimeout(150);
const back = await blockSource("Split panes");
check(back.includes("![dot](") && !back.includes("<img"), "Switch back to Markdown restores ![](…)");

await page.keyboard.press("Escape");
await page.waitForTimeout(100);
// (Mermaid's async rendering is covered deterministically in e2e-mermaid.mjs,
// which drives src/mermaid.ts directly — the editor's fast-typing choreography
// is too racy to build a fenced diagram reliably.)

await browser.close();
kill();
console.log(failures ? `\n${failures} FAILURES` : "\nall live-app checks passed");
process.exit(failures ? 1 : 0);
