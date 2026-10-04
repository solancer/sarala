/**
 * Live-app check of the AI assistant against the scripted mock agent
 * (src/ai/mock.ts, which speaks Claude Code's stream-json and edits the
 * working copy): real Vite dev server, real Chromium, no CLI or network.
 *
 *   node tests/e2e-ai.mjs   (starts its own server on :1423)
 *
 * Covers the full loop the unit tests can't: selection -> quick action ->
 * streamed reply -> proposal card -> accept edits the document -> undo
 * restores it; Accept all is one undo step; chat input respects IME
 * composition; review replies render.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1423;
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
const errors = [];
page.on("pageerror", (e) => { errors.push(e.message); console.log("[pageerror]", e.message); });
// Turn the assistant on with the mock agent before the app reads settings.
await page.addInitScript(() => {
  localStorage.setItem("sarala.settings", JSON.stringify({ aiEnabled: true, aiAgent: "mock" }));
});
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};
const mod = process.platform === "darwin" ? "Meta" : "Control";
const blockTexts = () => page.evaluate(() =>
  [...document.querySelectorAll(".editor .page > .block")].map((b) =>
    (b.querySelector(".source") ?? b).textContent.trim()));

/** Drag-select `word` inside the active block. */
async function selectWord(word) {
  const box = await page.evaluate((w) => {
    const el = document.querySelector(".block.active .source");
    const at = el.textContent.indexOf(w);
    if (at < 0) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    let pos = 0;
    let started = false;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const end = pos + n.data.length;
      if (!started && at <= end) { range.setStart(n, at - pos); started = true; }
      if (started && at + w.length <= end) { range.setEnd(n, at + w.length - pos); break; }
      pos = end;
    }
    const r = range.getBoundingClientRect();
    return { x0: r.left + 1, y: r.top + r.height / 2, x1: r.right - 1 };
  }, word);
  if (!box) throw new Error(`"${word}" not in the active block`);
  await page.mouse.move(box.x0, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x1, box.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(150);
}

async function quickAction(label) {
  await page.locator(".sel-bar .sel-ai .sel-type-btn").click();
  await page.locator(".sel-bar .sel-menu-item", { hasText: label }).click();
}

// Content: a heading and two paragraphs with typos.
await page.locator(".block").first().click();
await page.waitForSelector(".block.active .source");
await page.keyboard.type("# Notes");
await page.keyboard.press("Enter");
await page.keyboard.type("Teh cat sat.");
await page.keyboard.press("Enter");
await page.keyboard.type("Teh dog ran.");
await page.waitForTimeout(200);

// Header button opens the panel.
const toggle = page.locator(".ai-rail-main");
check(await toggle.isVisible(), "the right rail shows the assistant button");
await toggle.click();
const panel = page.locator(".ai-panel");
check(await panel.isVisible(), "panel opens");
check(await panel.locator(".ai-welcome").isVisible(), "welcome state is shown for a new chat");

// Quick action on a selection in the last paragraph.
await page.locator(".editor .page > .block").nth(2).click();
await selectWord("dog");
check(await page.locator(".sel-bar .sel-ai").isVisible(), "selection toolbar offers Ask AI");
await quickAction("Fix spelling");
const card = panel.locator(".ai-proposal").first();
await card.waitFor({ timeout: 5000 });
check(await panel.locator(".ai-user", { hasText: "Fix spelling" }).isVisible(), "transcript shows the quick action");
check(await panel.locator(".ai-user .ai-chip", { hasText: "dog" }).isVisible(), "the selection is attached as a chip");
check((await card.locator("ins").allTextContents()).join("").includes("The"), "diff shows the insertion");
check((await card.locator("del").allTextContents()).join("").includes("Teh"), "diff shows the deletion");
await panel.locator(".ai-assistant", { hasText: "Done." }).waitFor({ timeout: 5000 });
check(true, "the run finishes with the agent's reply");
check((await panel.locator(".ai-proposal").count()) === 1, "only the selected block is proposed for change");

check((await page.locator(".editor .page > .block.ai-pending").count()) === 1, "the pending block is marked in the editor margin");
check((await page.locator(".ai-rail-badge").textContent()) === "1", "the rail badge counts pending changes");

// Accept applies to the document; undo restores it.
await card.locator("button", { hasText: "Accept" }).click();
await page.waitForTimeout(150);
check((await page.locator(".editor .page > .block.ai-applied").count()) === 1, "the applied block glows");
check((await page.locator(".editor .page > .block.ai-pending").count()) === 0, "its margin marker is cleared");
let texts = await blockTexts();
check(texts[2] === "The dog ran.", `accept edits the block (got ${JSON.stringify(texts[2])})`);
check(await card.locator(".ai-state", { hasText: "Accepted" }).isVisible(), "card shows Accepted");
await page.keyboard.press(`${mod}+z`);
await page.waitForTimeout(150);
texts = await blockTexts();
check(texts[2] === "Teh dog ran.", `undo restores the block (got ${JSON.stringify(texts[2])})`);

// Two proposals, Accept all, one undo reverts both.
await page.locator(".editor .page > .block").nth(1).click();
await selectWord("cat");
await quickAction("Fix spelling");
await panel.locator(".ai-assistant", { hasText: "Done." }).nth(1).waitFor({ timeout: 5000 });
await page.locator(".editor .page > .block").nth(2).click();
await selectWord("dog");
await quickAction("Make shorter");
await panel.locator(".ai-assistant", { hasText: "Done." }).nth(2).waitFor({ timeout: 5000 });
const bulk = panel.locator(".ai-bulk");
check(await bulk.isVisible(), "bulk bar appears with several pending proposals");
await bulk.locator("button", { hasText: "Accept all" }).click();
await page.waitForTimeout(150);
texts = await blockTexts();
check(texts[1] === "The cat sat." && texts[2] === "The dog ran.", `accept all applies both (got ${JSON.stringify(texts.slice(1))})`);
await page.keyboard.press(`${mod}+z`);
await page.waitForTimeout(150);
texts = await blockTexts();
check(texts[1] === "Teh cat sat." && texts[2] === "Teh dog ran.", `one undo reverts accept all (got ${JSON.stringify(texts.slice(1))})`);

// Chat input: Enter sends, but never during IME composition.
const input = panel.locator(".ai-input");
await input.fill("こんにちは");
const before = await panel.locator(".ai-user").count();
await input.evaluate((el) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));
});
await page.waitForTimeout(150);
check((await panel.locator(".ai-user").count()) === before, "Enter during composition does not send");
await input.fill("How many blocks?");
await input.press("Enter");
await panel.locator(".ai-assistant", { hasText: "3 blocks" }).waitFor({ timeout: 5000 });
check(true, "a typed question gets a streamed reply about the document");

// A second chat: its own tab and transcript; the first one is kept.
const tabsBefore = await panel.locator(".ai-tab").count();
await panel.locator(".ai-tabs button[aria-label='New chat']").click();
check((await panel.locator(".ai-tab").count()) === tabsBefore + 1, "New chat opens another chat tab");
check(await panel.locator(".ai-welcome").isVisible(), "the new chat starts empty");
check((await panel.locator(".ai-tab-title").first().textContent()) === "Fix spelling & grammar", "chats are titled from their first message");
await panel.locator(".ai-tab-main").first().click();
check((await panel.locator(".ai-user").count()) > 0, "switching back shows the first chat's transcript");
await panel.locator(".ai-tab-main").last().click();
check(await panel.locator(".ai-welcome").isVisible(), "and switching again shows the new one");
await panel.locator(".ai-suggest-card", { hasText: "Review" }).click();
await panel.locator(".ai-assistant", { hasText: "more specific" }).waitFor({ timeout: 5000 });
check((await panel.locator(".ai-proposal").count()) === 0, "review replies without proposals");
await panel.locator(".ai-tab-main").last().dblclick();
await page.keyboard.press(`${mod}+a`);
await page.keyboard.type("Structure review");
await page.keyboard.press("Enter");
check((await panel.locator(".ai-tab-title").last().textContent()) === "Structure review", "double-click renames a chat");
const count = await panel.locator(".ai-tab").count();
await panel.locator(".ai-tab").last().locator(".ai-tab-x").click();
check((await panel.locator(".ai-tab").count()) === count - 1, "closing a chat removes its tab");

// Close with the header button; the palette command reopens it.
await panel.locator('button[aria-label="Close assistant"]').click();
check(!(await panel.isVisible()), "panel closes");

// Review flow: per-paragraph cards, keyboard focus after Accept, Revert,
// cards that go stale when their text is edited, and the change navigator.
{
  const rp = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  rp.on("pageerror", (e) => errors.push(e.message));
  await rp.addInitScript(() => localStorage.setItem("sarala.settings", JSON.stringify({ aiEnabled: true, aiAgent: "mock" })));
  await rp.goto(`http://localhost:${PORT}`);
  await rp.waitForSelector(".block");
  await rp.locator(".block").first().click();
  await rp.keyboard.type("# Notes"); await rp.keyboard.press("Enter");
  await rp.keyboard.type("Teh cat sat."); await rp.keyboard.press("Enter");
  await rp.keyboard.type("Teh dog ran."); await rp.keyboard.press("Enter");
  await rp.keyboard.type("Teh bird sang.");
  await rp.locator(".ai-rail-main").click();
  await rp.locator(".ai-suggest-card", { hasText: "Proofread" }).click();
  await rp.locator(".ai-proposal").nth(2).waitFor({ timeout: 5000 });
  check((await rp.locator(".ai-proposal").count()) === 3, "each edited paragraph gets its own card");
  check(await rp.locator(".ai-meta", { hasText: "3 changes proposed" }).isVisible(), "the reply says how many changes it proposed");
  await rp.locator(".ai-proposal").first().locator(".ai-primary").focus();
  await rp.keyboard.press("Enter");
  await rp.waitForTimeout(250);
  const focused = await rp.evaluate(() => document.activeElement?.closest(".ai-proposal")?.getAttribute("data-proposal") ?? null);
  const second = await rp.locator(".ai-proposal").nth(1).getAttribute("data-proposal");
  check(focused === second, "after Accept, focus moves to the next card");
  const texts = () => rp.evaluate(() => [...document.querySelectorAll(".editor .page > .block")].map((b) => b.textContent.trim()));
  check((await texts())[1] === "The cat sat.", "the accepted card applied");
  await rp.locator(".ai-proposal").first().locator(".ai-revert").click();
  await rp.waitForTimeout(250);
  check((await texts())[1] === "Teh cat sat.", "Revert puts the original text back");
  check(await rp.locator(".ai-proposal").first().locator(".ai-primary").isVisible(), "and the change can be accepted again");
  await rp.locator(".editor .page > .block").nth(3).click();
  await rp.keyboard.press("End"); await rp.keyboard.type("!");
  await rp.mouse.click(600, 700);
  await rp.waitForTimeout(300);
  check(await rp.locator(".ai-proposal").nth(2).locator(".ai-stale-note").isVisible(), "editing a card's text marks it out of date right away");
  check(!(await rp.locator(".ai-proposal").nth(2).locator(".ai-primary").isVisible()), "and its Accept is withdrawn");
  await rp.locator(".ai-bulk .ai-nav-btn").last().click();
  await rp.waitForTimeout(200);
  check(/^1 of \d/.test((await rp.locator(".ai-bulk-count").textContent()).trim()), "the navigator steps through changes");
  check(await rp.locator(".ai-panel .sr-only[role=status]").count() === 1, "a status region announces progress for screen readers");
  check((await rp.locator(".ai-list").getAttribute("aria-live")) === "off", "and the streaming log itself is not a live region");
  await rp.close();
}

// No agent CLI on this computer: onboarding can't turn on, the install
// screen replaces the chat, and the rail shows that setup is needed.
const bare = await browser.newPage();
bare.on("pageerror", (e) => errors.push(e.message));
await bare.addInitScript(() => { localStorage.setItem("sarala.settings", "{}"); globalThis.__saralaNoAgents = true; });
await bare.goto(`http://localhost:${PORT}`);
await bare.waitForSelector(".block");
await bare.locator(".ai-rail-main").click();
await bare.locator(".ai-agent-card").first().waitFor();
await bare.waitForTimeout(300);
check((await bare.locator(".ai-agent-card .ai-pill", { hasText: "Not installed" }).count()) >= 3, "onboarding lists each agent as not installed");
check((await bare.locator(".ai-cmd code").count()) >= 3, "with an install command to copy");
check(await bare.locator(".ai-hero-cta").isDisabled(), "Turn on is disabled until an agent is installed");
await bare.close();
const bare2 = await browser.newPage();
bare2.on("pageerror", (e) => errors.push(e.message));
await bare2.addInitScript(() => {
  localStorage.setItem("sarala.settings", JSON.stringify({ aiEnabled: true, aiAgent: "claude-code" }));
  globalThis.__saralaNoAgents = true;
});
await bare2.goto(`http://localhost:${PORT}`);
await bare2.waitForSelector(".block");
await bare2.waitForTimeout(400);
check(await bare2.locator(".ai-rail-setup").isVisible(), "the rail shows a setup-needed dot");
await bare2.locator(".ai-rail-main").click();
await bare2.locator(".ai-install").waitFor();
check(await bare2.locator(".ai-install", { hasText: "Install an agent" }).isVisible(), "the install screen replaces the chat");
check((await bare2.locator(".ai-input").count()) === 0, "no composer to send doomed messages");
await bare2.close();

check(errors.length === 0, "no page errors");
await browser.close();
kill();
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
