/**
 * AI assistant performance benchmark, driven by the dev-only mock agent in the
 * browser build. Times what must stay instant while the assistant is in use:
 * typing with many pending changes marked in the editor, opening the panel,
 * switching between chats with long transcripts, streaming a long reply,
 * turning a whole-document edit into proposals, and Accept all.
 *
 *   node tests/perf-ai.mjs            # print timings
 *   node tests/perf-ai.mjs --assert   # also fail on budget regressions
 *
 * Timings run until the next frame has rendered (style/layout/paint
 * included); "(script)" rows are the synchronous JavaScript alone.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const ASSERT = process.argv.includes("--assert");
const BUDGET = {
  typingWithMarks: 30, panelOpen: 60, panelClose: 40, chatSwitch: 60, streamLongestFrame: 50,
  proposalsReady: 250, acceptAll: 120, diffBlocksLarge: 60,
};

const fixture = await readFile(new URL("./fixtures/kafka-guide.md", import.meta.url), "utf8");
// Every "the" becomes "teh" so the mock's proofread touches most blocks.
const typoed = fixture.replace(/\bthe\b/g, "teh");
const longReply = Array.from({ length: 40 }, (_, i) =>
  `## Point ${i + 1}\n\nThis paragraph explains a **finding** in some detail, with \`code\`, a [link](https://example.com) and enough words to wrap across several lines in the panel.\n\n- first item\n- second item with *emphasis*`).join("\n\n");

const port = 1438;
const server = spawn("node", ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"], { stdio: "pipe" });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Vite startup timed out")), 20000);
    server.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); } });
    server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Vite exited: ${code}`)); });
  });
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  page.on("pageerror", (e) => console.error("pageerror:", e.message));
  await page.addInitScript(() => {
    localStorage.setItem("sarala.settings", JSON.stringify({ aiEnabled: true, aiAgent: "mock" }));
    globalThis.__saralaMockDelay = 0;
  });
  await page.goto(`http://localhost:${port}`);
  await page.waitForSelector('[role="tab"]');

  const results = await page.evaluate(async ({ typoed, longReply }) => {
    const store = await import("/src/store.ts");
    const config = await import("/src/ai/config.ts");
    const session = await import("/src/ai/session.ts");
    const proposals = await import("/src/ai/proposals.ts");
    const md = await import("/src/markdown.ts");
    const frame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const scripting = {};
    const time = async (bucket, fn) => {
      const t0 = performance.now(); fn(); const t1 = performance.now();
      (scripting[bucket] ??= []).push(t1 - t0);
      await frame();
      return performance.now() - t0;
    };
    const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const idle = async () => { while (session.currentChat()?.busy) await new Promise((r) => setTimeout(r, 10)); await frame(); };
    // Jank meter: the longest gap between animation frames (a stalled main
    // thread shows up as a long gap). Headless Chromium has no longtask API.
    let longest = 0;
    let lastFrame = performance.now();
    let metering = true;
    const meter = () => {
      const now = performance.now();
      longest = Math.max(longest, now - lastFrame);
      lastFrame = now;
      if (metering) requestAnimationFrame(meter);
    };
    requestAnimationFrame(meter);
    const resetMeter = () => { longest = 0; lastFrame = performance.now(); };
    const out = {};

    store.openDocument(typoed, "/bench/kafka-typos.md");
    await new Promise((r) => setTimeout(r, 1500)); // let diagrams and lazy rendering settle

    // Panel open/close.
    const opens = [], closes = [];
    for (let i = 0; i < 5; i++) {
      opens.push(await time("panelOpen", () => config.setAiPanelOpen(true)));
      closes.push(await time("panelClose", () => config.setAiPanelOpen(false)));
    }
    out.panelOpen = median(opens);
    out.panelClose = median(closes);
    config.setAiPanelOpen(true); await frame();

    // Whole-document proofread: many blocks change at once.
    resetMeter();
    let t0 = performance.now();
    void session.send("Proofread the whole document.");
    await idle();
    await frame();
    out.proposalsReady = performance.now() - t0;
    out.proposalsLongestFrame = longest;
    out.proposals = session.pendingProposals().length;
    if (out.proposals < 20) throw new Error(`expected many proposals, got ${out.proposals}`);

    // Typing while every one of those changes is marked in the editor margin.
    const para = store.doc.blocks.findIndex((b) => b.text.startsWith("Before Kafka"));
    store.requestCaret(0); store.setActive(para); await frame();
    const typing = [];
    for (let i = 0; i < 10; i++) {
      const idx = store.doc.activeIndex, text = store.doc.blocks[idx].text;
      typing.push(await time("typingWithMarks", () => store.updateBlock(idx, text + "x")));
    }
    out.typingWithMarks = median(typing);
    store.setActive(-1); await frame();

    // Long streamed reply (markdown re-rendered as it grows).
    globalThis.__saralaMockReply = longReply;
    session.newChat(); await frame();
    let renders = 0, renderMs = 0;
    const r0 = performance.now(); md.renderMarkdown(longReply); out.renderLongReply = performance.now() - r0;
    resetMeter();
    t0 = performance.now();
    void session.send("Explain everything.");
    await idle();
    out.streamTotal = performance.now() - t0;
    out.streamLongestFrame = longest;
    void renders; void renderMs;
    out.streamChars = longReply.length;

    // A long transcript: 40 exchanges in one chat, then switch chats back and forth.
    globalThis.__saralaMockReply = "Short answer with a little **markdown** and a [link](https://example.com).";
    session.newChat(); await frame();
    const longChat = session.currentChat().id;
    for (let i = 0; i < 40; i++) { void session.send(`Question ${i}?`); await idle(); }
    const chats = session.docChats().map((c) => c.id);
    const switches = [];
    for (let i = 0; i < 6; i++) {
      const target = i % 2 ? longChat : chats[0];
      switches.push(await time("chatSwitch", () => session.selectChat(target)));
    }
    out.chatSwitch = median(switches);
    out.longChatItems = session.docChats().find((c) => c.id === longChat).items.length;
    delete globalThis.__saralaMockReply;

    // Accept all of the proofread's changes (one undo step, many splices).
    session.selectChat(chats[0]); await frame();
    out.acceptAll = await time("acceptAll", () => session.acceptAll());
    out.accepted = session.docChats().flatMap((c) => Object.values(c.proposals)).filter((p) => p.status === "accepted").length;

    // Pure diff on a large document (10× the fixture).
    const big = Array.from({ length: 10 }, () => typoed).join("\n\n");
    const before = md.splitBlocks(big).map((text, id) => ({ id, text }));
    const after = md.splitBlocks(big.replace(/\bteh\b/g, "the"));
    t0 = performance.now();
    const ps = proposals.diffBlocks(before, after, (() => { let n = 0; return () => `p${n++}`; })());
    out.diffBlocksLarge = performance.now() - t0;
    out.diffBlocksCount = `${before.length} blocks → ${ps.length} proposals`;

    for (const [k, xs] of Object.entries(scripting)) out[`${k} (script)`] = median(xs);
    metering = false;
    return out;
  }, { typoed, longReply });

  const fmt = (v) => (typeof v === "number" ? `${v.toFixed(1).padStart(8)} ms` : String(v));
  for (const [k, v] of Object.entries(results)) {
    const plain = ["proposals", "streamChars", "longChatItems", "accepted", "diffBlocksCount"].includes(k);
    console.log(`${k.padEnd(24)}${plain ? String(v).padStart(8) : fmt(v)}${BUDGET[k] ? `   (budget ${BUDGET[k]} ms)` : ""}`);
  }
  if (ASSERT) for (const [k, budget] of Object.entries(BUDGET)) assert.ok(results[k] <= budget, `${k} took ${results[k].toFixed(1)} ms (budget ${budget} ms)`);
} finally {
  await browser?.close();
  server.kill();
}
