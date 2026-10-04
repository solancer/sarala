/**
 * Voice typing, end to end in the browser with the dev mock standing in for
 * the microphone and the speech model (src/voice/mock.ts).
 *
 *   node tests/e2e-voice.mjs   (starts its own server on :1453)
 *
 * Covers the opt-in set-up, hold-to-talk and tap-to-toggle, where the words
 * land (editor block, AI composer, no caret), the block invariant and undo,
 * Escape, "new paragraph", and the permission and silence notices.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1453;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const shortcut = process.platform === "darwin" ? ["Meta", "Shift", "KeyD"] : ["Control", "Alt", "Space"];
const server = spawn("npx", ["vite", "--port", String(PORT)], { stdio: "pipe" });
const kill = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", kill);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("vite did not start")), 20000);
  server.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); } });
});

let failures = 0;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failures++; };
const browser = await chromium.launch();

async function newPage({ settings = {}, installed = [] } = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
  await page.addInitScript(({ s, i }) => {
    localStorage.setItem("sarala.settings", JSON.stringify(s));
    localStorage.setItem("sarala.voiceMockInstalled", JSON.stringify(i));
    window.__saralaVoiceDelay = 40;
    // Count earcons: a fake AudioContext records each tone's frequency.
    window.__tones = [];
    window.AudioContext = class {
      constructor() { this.currentTime = 0; this.state = "running"; this.destination = {}; }
      resume() {}
      createGain() { return { gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect: (d) => d }; }
      createOscillator() {
        const o = { frequency: { value: 0 }, type: "", connect: (g) => g, start: () => window.__tones.push(o.frequency.value), stop() {} };
        return o;
      }
    };
  }, { s: settings, i: installed });
  await page.goto(`http://localhost:${PORT}`);
  await page.waitForSelector(".block");
  return page;
}
const store = (page, fn, arg) =>
  page.evaluate(async ({ fn, arg }) => (0, eval)(fn)(await import("/src/store.ts"), arg), { fn: String(fn), arg });
const blocks = (page) => store(page, (s) => s.doc.blocks.map((b) => b.text));
const down = async (page) => { for (const k of shortcut) await page.keyboard.down(k); };
const up = async (page) => { for (const k of [...shortcut].reverse()) await page.keyboard.up(k); };
/** Hold the shortcut while the mock "speaks", then let go. */
const hold = async (page, ms = 900) => { await down(page); await page.waitForTimeout(ms); await up(page); await page.waitForTimeout(250); };
const tap = async (page) => { await down(page); await up(page); };
const caretAtEnd = async (page, text) => {
  await page.locator(".editor .page > .block").filter({ hasText: text }).first().click();
  // End of the block, not just of the clicked line.
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
};

// ---- 1. Off by default; the set-up is the opt-in ----
{
  const page = await newPage();
  const clashes = await page.evaluate(async () => {
    const { SHORTCUTS } = await import("/src/voice/config.ts");
    const { appShortcuts } = await import("/src/components/VoiceSettings.tsx");
    const taken = appShortcuts();
    return SHORTCUTS.filter((s) => taken.has(s.id)).map((s) => `${s.id} = ${taken.get(s.id)}`);
  });
  check(clashes.length === 0, `no suggested shortcut clashes with Sarala's own (${clashes.join(", ") || "none"})`);
  check(!(await page.locator(".topbar-toggle.voice-top").count()), "voice typing is off by default: no mic button");
  await tap(page);
  await page.waitForTimeout(200);
  check(!(await page.locator(".voice-setup").count()), "the shortcut does nothing before opting in");

  await page.evaluate(async () => (await import("/src/commands.ts")).executeCommand("app.settings"));
  await page.locator(".set-rail-item", { hasText: "Voice" }).click();
  await page.locator('[role="switch"][aria-label="Voice typing"]').click();
  await page.waitForSelector(".voice-setup");
  check(await page.locator(".voice-model").count() === 4, "set-up offers four models");
  check(await page.locator(".voice-model.on", { hasText: "Parakeet" }).count() === 1, "Parakeet is preselected for an English locale");
  check(await page.locator(".voice-model", { hasText: "Recommended" }).count() === 1, "one model is marked Recommended");
  const cta = page.locator(".voice-setup .pandoc-btn.primary");
  check(/Download 477 MB/.test(await cta.textContent()), "the button names the download size");
  await page.locator(".voice-model", { hasText: "Moonshine" }).click();
  check(/Download 77 MB/.test(await cta.textContent()), "choosing another model updates the size");
  await page.locator(".voice-model", { hasText: "Parakeet" }).click();
  await cta.click();
  await page.waitForSelector(".voice-progress");
  check(await page.locator('.voice-progress[role="progressbar"]').count() === 1, "download shows a progress bar");
  await page.waitForSelector("text=Voice typing is on", { timeout: 5000 });
  check(true, "download, microphone and model preparation lead to the ready step");
  await page.waitForTimeout(400); // settings writes are debounced
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("sarala.settings")));
  check(saved.voiceEnabled === true && saved.voiceModel === "parakeet-en", "turning on is saved with the chosen model");

  // Try it in the set-up's own field.
  await page.locator(".voice-try textarea").click();
  await hold(page, 900);
  await page.waitForTimeout(200);
  const tried = await page.locator(".voice-try textarea").inputValue();
  check(tried === "The quick brown fox jumps over the lazy dog.", `hold-to-talk types into the try-it field (${JSON.stringify(tried)})`);
  check(/✓ The shortcut works/.test(await page.locator(".voice-check").textContent()), "the set-up confirms the shortcut reaches Sarala");
  await page.locator(".voice-setup .pandoc-btn.primary", { hasText: "Done" }).click();
  check(await page.locator(".topbar-toggle.voice-top").count() === 1, "the mic button appears beside Focus mode");
  await page.close();
}

const on = { settings: { voiceEnabled: true, voiceModel: "parakeet-en", aiEnabled: true, aiAgent: "mock" }, installed: ["parakeet-en"] };

// ---- 2. Into an editor block: tap to toggle, live text, invariant, undo ----
{
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Intro paragraph.\n\nI went to the", "/bench/voice.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "I went to the");
  await page.evaluate(() => { window.__saralaVoiceScript = "Market on Sunday morning with my sister."; window.__saralaVoiceDelay = 150; });
  await tap(page);
  await page.waitForSelector(".voice-hud");
  check(await page.locator(".voice-hud-hint").textContent().then((t) => /Text appears as you speak/.test(t) && /for a command/.test(t)), "a tap latches listening on, and the hint says how it works");
  check(await page.locator(".topbar-toggle.voice-top[aria-pressed=true]").count() === 1, "the mic button shows it is listening");
  await page.waitForTimeout(250);
  const streaming = (await blocks(page))[1];
  check(/^I went to the market/.test(streaming) && streaming.length < "I went to the market on Sunday morning with my sister.".length,
    `words stream into the document while they are spoken (${JSON.stringify(streaming)})`);
  check(await page.evaluate(() => CSS.highlights?.has("voice-live")), "words still being recognized are marked");
  check(!(await page.locator(".voice-hud-text").count()), "and the HUD doesn't repeat them");
  await page.waitForTimeout(1000);
  await tap(page);
  await page.waitForTimeout(300);
  check(!(await page.locator(".voice-hud").count()), "a second tap finishes");
  const after = (await blocks(page))[1];
  check(after === "I went to the market on Sunday morning with my sister.", `words join the sentence with a space and a lowered capital (${JSON.stringify(after)})`);
  const invariant = await page.evaluate(async () => {
    const s = await import("/src/store.ts");
    const el = document.querySelectorAll(".editor .page > .block")[1].querySelector(".source");
    return el ? el.textContent === s.doc.blocks[1].text : true;
  });
  check(invariant, "the block's text is still its Markdown source");
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(200);
  check((await blocks(page))[1] === "I went to the", "one undo removes the whole dictation");
  const status = await page.locator('.voice-status').textContent();
  check(status === "Typed: market on Sunday morning with my sister.", `screen readers hear what was typed (${JSON.stringify(status)})`);
  await page.close();
}

// ---- 3. Escape cancels; "new paragraph"; silence; denied ----
{
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Start here.", "/bench/voice2.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "Start here.");
  await tap(page);
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  check(!(await page.locator(".voice-hud:not(.voice-notice)").count()) && (await blocks(page)).join("|") === "Start here.", "Escape cancels without typing anything");
  check(await page.locator(".editor .page > .block .source").count() === 1, "and the caret stays in the block");

  // Return keeps the text (and adds no line break); Escape discards it, but
  // recoverably: Restore or Undo brings the words back.
  await page.evaluate(() => { window.__saralaVoiceDelay = 60; window.__saralaVoiceScript = "Keep these words."; });
  await tap(page);
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);
  check((await blocks(page)).join("|") === "Start here. Keep these words." && !(await page.locator(".voice-hud:not(.voice-notice)").count()),
    `Return finishes and keeps the text, without a line break (${JSON.stringify(await blocks(page))})`);
  check(await page.locator('.voice-hud-btn[aria-keyshortcuts="Enter"]').count() === 0, "the panel is gone once finished");
  await page.evaluate(() => { window.__saralaVoiceScript = "Words I will discard."; });
  await tap(page);
  await page.waitForTimeout(600);
  check(await page.locator('.voice-hud-btn[aria-keyshortcuts="Enter"]', { hasText: "Done" }).count() === 1
    && await page.locator('.voice-hud-btn[aria-keyshortcuts="Escape"]', { hasText: "Cancel" }).count() === 1, "Done and Cancel show their keys");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  check((await blocks(page)).join("|") === "Start here. Keep these words.", "Escape discards what was being said");
  check(await page.locator(".voice-notice", { hasText: "Discarded" }).count() === 1, "and says so, with a way back");
  await page.locator(".voice-notice .voice-hud-btn", { hasText: "Restore" }).click();
  await page.waitForTimeout(250);
  check((await blocks(page))[0].startsWith("Start here. Keep these words. Words I will"), `Restore brings the discarded words back (${JSON.stringify(await blocks(page))})`);
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(200);
  check((await blocks(page))[0] === "Start here. Keep these words.", `and Undo takes them away again (${JSON.stringify(await blocks(page))}, focus ${await page.evaluate(() => document.activeElement?.className)})`);
  await page.keyboard.press(`${mod}+Shift+z`);
  await page.waitForTimeout(200);
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(150);
  await caretAtEnd(page, "Keep these words.");
  await page.evaluate(() => { window.__saralaVoiceScript = "Gone with escape."; });
  await tap(page);
  await page.waitForTimeout(600);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(250);
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(250);
  check((await blocks(page))[0].includes("Gone with"), `after Escape, plain Undo also brings the words back (${JSON.stringify(await blocks(page))})`);
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(150);
  await page.evaluate(() => { window.__saralaVoiceDelay = 40; window.__saralaVoiceScript = undefined; });
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowRight" : "End");

  await page.evaluate(() => { window.__saralaVoiceScript = "First point. New paragraph. second point."; });
  await hold(page, 600);
  await page.waitForTimeout(300);
  const paras = await blocks(page);
  check(paras.length === 2 && paras[0] === "Start here. Keep these words. First point." && paras[1] === "Second point.", `"new paragraph" starts a new block (${JSON.stringify(paras)})`);

  await page.evaluate(() => { window.__saralaVoiceSilent = true; });
  await hold(page, 400);
  await page.waitForTimeout(200);
  check(await page.locator(".voice-notice", { hasText: "Didn't catch that" }).count() === 1, "silence says nothing was typed");

  await page.evaluate(() => { window.__saralaVoiceSilent = false; window.__saralaVoicePermission = "denied"; });
  await tap(page);
  await page.waitForTimeout(300);
  check(await page.locator(".voice-notice.error", { hasText: "Microphone access is off" }).count() === 1, "a blocked microphone is explained");
  check(await page.locator(".voice-notice .voice-hud-btn", { hasText: "Open Privacy Settings" }).count() === (process.platform === "linux" ? 0 : 1), "with a link to the privacy settings where the OS has one");
  await page.close();
}

// ---- 3b. Stop or cancel while the microphone is still opening ----
{
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Race here.", "/bench/voice-race.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "Race here.");
  await page.evaluate(() => { window.__saralaVoiceOpenDelay = 300; });
  await tap(page);
  await page.waitForTimeout(50);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  check(!(await page.evaluate(() => window.__saralaVoiceMicOpen)), "cancelling while the mic opens leaves it closed");
  check(!(await page.locator(".voice-hud").count()), "and the HUD is gone");
  await tap(page);
  await page.waitForTimeout(50);
  await tap(page);
  await page.waitForTimeout(700);
  check(!(await page.evaluate(() => window.__saralaVoiceMicOpen)), "stopping while the mic opens also closes it");
  check(!(await page.locator(".voice-hud:not(.voice-notice)").count()), "and finishes cleanly");
  check(await page.locator(".voice-notice", { hasText: "Didn't catch that" }).count() === 1, "saying nothing was heard yet");
  await page.evaluate(() => { window.__saralaVoiceOpenDelay = 0; });
  await hold(page, 900);
  await page.waitForTimeout(200);
  check((await blocks(page))[0] === "Race here. The quick brown fox jumps over the lazy dog.", "the next dictation works normally");
  await page.close();
}

// ---- 5. Sounds, read-back off, commands, correction ----
{
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Notes.", "/bench/voice5.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "Notes.");
  await hold(page, 900);
  const tones = await page.evaluate(() => window.__tones);
  check(tones.slice(0, 2).join() === "660,880" && tones.slice(-2).join() === "880,660", `rising tones start, falling tones finish (${tones})`);
  check((await blocks(page))[0] === "Notes. The quick brown fox jumps over the lazy dog.", "text typed");

  await page.evaluate(() => { window.__saralaVoiceScript = "Scratch that."; });
  await hold(page, 500);
  check((await blocks(page))[0] === "Notes.", `"scratch that" removes the last dictation (${JSON.stringify((await blocks(page))[0])})`);
  check((await page.locator('.voice-status').textContent()).startsWith("Removed:"), "and says what it removed");

  await page.evaluate(() => { window.__saralaVoiceScript = "Draft words here."; });
  await hold(page, 600);
  await page.evaluate(async () => (await import("/src/commands.ts")).executeCommand("voice.select_last"));
  await page.waitForTimeout(200);
  const sel = await page.evaluate(() => window.getSelection()?.toString());
  check(sel === "Draft words here.", `Select Last Dictation selects it (${JSON.stringify(sel)})`);
  await page.evaluate(() => { window.__saralaVoiceScript = "Final words."; });
  await hold(page, 500);
  check((await blocks(page))[0] === "Notes. Final words.", `dictating again replaces the selection (${JSON.stringify((await blocks(page))[0])})`);
  await page.evaluate(async () => (await import("/src/commands.ts")).executeCommand("voice.scratch"));
  await page.waitForTimeout(150);
  check((await blocks(page))[0] === "Notes.", "Remove Last Dictation works from the menu too");

  // Settings: sounds off, read-back off, spoken punctuation on.
  await page.evaluate(async () => {
    const c = await import("/src/voice/config.ts");
    await c.setVoiceSounds(false); await c.setVoiceReadBack(false); await c.setVoicePunctuation(true);
    window.__tones = [];
    window.__saralaVoiceScript = "is it done question mark new line yes";
  });
  await caretAtEnd(page, "Notes.");
  await hold(page, 700);
  check(!(await page.evaluate(() => window.__tones.length)), "no sounds when Sounds is off");
  check((await page.locator('.voice-status').textContent()) === "Typed 4 words", "read-back off says only the word count");
  check((await blocks(page))[0] === "Notes. Is it done?\nYes", `spoken punctuation and "new line" (${JSON.stringify((await blocks(page))[0])})`);
  await page.close();
}

// ---- 5b. Markdown commands and the commands sheet ----
{
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Groceries:", "/bench/voice5b.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "Groceries:");
  const say = async (script, ms = 700) => {
    await page.evaluate((t) => { window.__saralaVoiceScript = t; }, script);
    await tap(page);
    await page.waitForTimeout(ms);
    await tap(page);
    await page.waitForTimeout(350);
  };
  await say("new bullet buy milk new bullet call mom", 900);
  check(JSON.stringify(await blocks(page)) === JSON.stringify(["Groceries:", "- Buy milk\n- Call mom"]), `"new bullet" builds a Markdown list (${JSON.stringify(await blocks(page))})`);
  // Straight after a list that split the block: "that" is the last item;
  // "scratch that" removes the whole dictation.
  await say("make that bold", 400);
  check((await blocks(page))[1] === "- Buy milk\n- **Call mom**", `"make that bold" right after a new list bolds its last item (${JSON.stringify((await blocks(page))[1])})`);
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(200);
  await say("scratch that", 400);
  check(JSON.stringify(await blocks(page)) === JSON.stringify(["Groceries:"]), `"scratch that" removes a whole multi-block dictation (${JSON.stringify(await blocks(page))})`);
  await page.keyboard.press(`${mod}+z`);
  await page.waitForTimeout(250);
  check(JSON.stringify(await blocks(page)) === JSON.stringify(["Groceries:", "- Buy milk\n- Call mom"]), "and Undo brings it back");
  await caretAtEnd(page, "Call mom");
  await say("next bullet bread");
  check((await blocks(page))[1] === "- Buy milk\n- Call mom\n- Bread", `a bullet after a list item continues the list (${JSON.stringify((await blocks(page))[1])})`);
  await say("Bold that.", 400);
  check((await blocks(page))[1] === "- Buy milk\n- Call mom\n- **Bread**", `"bold that" bolds the last dictation (${JSON.stringify((await blocks(page))[1])})`);
  check((await page.locator(".voice-status").textContent()) === "Bold: Bread", "and says what it did");
  await say("make that a task", 400);
  check((await blocks(page))[1].endsWith("\n- [ ] **Bread**"), `"make that a task" turns its line into a checklist item (${JSON.stringify((await blocks(page))[1])})`);
  await say("new heading next steps");
  const b = await blocks(page);
  check(b[b.length - 1] === "## Next steps", `"new heading" starts a heading block (${JSON.stringify(b)})`);
  await say("We need a new heading for this section.");
  check((await blocks(page)).some((x) => /we need a new heading for this section/i.test(x)), `prose that mentions a heading stays text (${JSON.stringify(await blocks(page))})`);

  // The commands sheet: by voice, from the panel, from the menu command.
  await say("What can I say?", 400);
  await page.waitForTimeout(250);
  check(await page.locator(".voice-commands").isVisible(), "saying “what can I say” opens the commands sheet");
  check(!(await page.locator(".voice-hud:not(.voice-notice)").count()), "and finishes listening first");
  check(await page.locator(".voice-commands h3").count() >= 5 && await page.locator(".voice-commands dt").count() >= 15, "the sheet lists commands in sections");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  check(!(await page.locator(".voice-commands").count()), "Escape closes the sheet");
  await tap(page);
  await page.waitForTimeout(300);
  await page.locator(".voice-hud-btn", { hasText: "Commands" }).click();
  await page.waitForTimeout(250);
  check(await page.locator(".voice-commands").isVisible(), "the panel's Commands button opens it too");
  await page.keyboard.press("Escape");
  await page.evaluate(async () => { await (await import("/src/voice/config.ts")).setVoiceCommands(false); });
  await page.evaluate(async () => (await import("/src/commands.ts")).executeCommand("voice.commands"));
  await page.waitForTimeout(200);
  check(await page.locator(".voice-cmd-off", { hasText: "Voice commands are off" }).count() === 1, "the sheet says when commands are off, with a way to turn them on");
  await page.locator(".voice-cmd-off button", { hasText: "Turn on" }).click();
  check(await page.evaluate(async () => (await import("/src/voice/config.ts")).voiceCommands()), "and turning them on there works");
  await page.close();
}

// ---- 5c. The command key: tap to dictate, hold for a command ----
{
  const cmdKey = process.platform === "darwin" ? "AltRight" : "ControlRight";
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Start.", "/bench/voice5c.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "Start.");
  const hud = () => page.locator(".voice-hud:not(.voice-notice)");

  // Tap: start and stop.
  await page.evaluate(() => { window.__saralaVoiceDelay = 60; window.__saralaVoiceScript = "Tapped in."; });
  await page.keyboard.press(cmdKey);
  await page.waitForTimeout(500);
  check(await hud().count() === 1, "tapping the command key alone starts dictation");
  await page.keyboard.press(cmdKey);
  await page.waitForTimeout(350);
  check(!(await hud().count()) && (await blocks(page))[0] === "Start. Tapped in.", `tapping again finishes (${JSON.stringify(await blocks(page))})`);

  // Hold while dictating: what was said is typed, then the command runs.
  await page.evaluate(() => { window.__saralaVoiceScript = "Some words here | make that bold."; window.__saralaVoicePauseTicks = 12; window.__tones = []; });
  await page.keyboard.press(cmdKey);
  await page.waitForTimeout(450);
  await page.keyboard.down(cmdKey);
  await page.waitForTimeout(500);
  check(await hud().locator(".voice-hud-label", { hasText: "Say a command" }).count() === 1, "holding it switches to command mode");
  check((await blocks(page))[0] === "Start. Tapped in. Some words here", `what was said before is typed first (${JSON.stringify(await blocks(page))})`);
  check((await page.evaluate(() => window.__tones)).includes(587), "with the command sound");
  await page.waitForTimeout(1300);
  check(!(await blocks(page))[0].toLowerCase().includes("bold"), "the command's words never reach the document");
  await page.keyboard.up(cmdKey);
  await page.waitForTimeout(400);
  check((await blocks(page))[0] === "Start. Tapped in. **Some words here**", `releasing runs it ("make that bold") (${JSON.stringify(await blocks(page))})`);
  check(await hud().locator(".voice-hud-label", { hasText: "Listening" }).count() === 1, "and dictation carries on");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(350);

  // Hold when not dictating: a one-shot command.
  await page.evaluate(() => { window.__saralaVoiceScript = "make that a heading"; });
  await page.keyboard.down(cmdKey);
  await page.waitForTimeout(1100);
  await page.keyboard.up(cmdKey);
  await page.waitForTimeout(450);
  check((await blocks(page))[0].startsWith("## Start."), `holding it when idle runs one command ("make that a heading") (${JSON.stringify(await blocks(page))})`);
  check(!(await hud().count()), "and doesn't leave dictation running");

  // Not a command: nothing typed, and it says so.
  const before = await blocks(page);
  await page.evaluate(() => { window.__saralaVoiceScript = "banana bread"; });
  await page.keyboard.down(cmdKey);
  await page.waitForTimeout(900);
  await page.keyboard.up(cmdKey);
  await page.waitForTimeout(450);
  check(JSON.stringify(await blocks(page)) === JSON.stringify(before), "an unknown command types nothing");
  check(await page.locator(".voice-notice", { hasText: "isn't a command" }).count() === 1, "and says it isn't a command, with a way to see them");

  // The key used as a modifier for typing (Option+E) does nothing voice-wise.
  await page.keyboard.down(cmdKey);
  await page.keyboard.press("KeyE");
  await page.waitForTimeout(450);
  await page.keyboard.up(cmdKey);
  await page.waitForTimeout(250);
  check(!(await hud().count()), "with another key it stays a modifier: no dictation, no command");

  // Off in Settings.
  await page.evaluate(async () => { await (await import("/src/voice/config.ts")).setVoiceCommandKey("off"); });
  await page.keyboard.press(cmdKey);
  await page.waitForTimeout(400);
  check(!(await hud().count()), "turned off, the key does nothing");
  await page.close();
}

// ---- 5d. If the hold-to-command commit catches nothing, the command that
// follows must not reach back and act on an older, unrelated dictation ----
{
  const cmdKey = process.platform === "darwin" ? "AltRight" : "ControlRight";
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Notes.", "/bench/voice5d.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "Notes.");

  // An earlier, separate, already-committed dictation: this is "last
  // dictation" going into the scenario below.
  await page.evaluate(() => { window.__saralaVoiceScript = "Older paragraph."; });
  await tap(page);
  await page.waitForTimeout(500);
  await tap(page);
  await page.waitForTimeout(350);
  check((await blocks(page))[0] === "Notes. Older paragraph.", "setup: an earlier dictation is committed");

  // Start a new session and hold the command key while the engine is still
  // mid-pause (nothing heard yet this session, so the "type what was said
  // so far" commit comes back empty) — then "scratch that" is heard only
  // after that, during the hold.
  await page.evaluate(() => { window.__saralaVoiceScript = "| scratch that"; window.__saralaVoicePauseTicks = 20; });
  await tap(page);
  await page.waitForTimeout(80);
  await page.keyboard.down(cmdKey);
  await page.waitForTimeout(1100);
  await page.keyboard.up(cmdKey);
  await page.waitForTimeout(400);
  check(
    (await blocks(page))[0] === "Notes. Older paragraph.",
    `a missed commit doesn't let "scratch that" reach back to older, unrelated work (${JSON.stringify((await blocks(page))[0])})`,
  );
  await page.close();
}

// ---- 5e. Table commands ----
{
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Notes.", "/bench/voice5e.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "Notes.");
  const say = async (script, ms = 700) => {
    await page.evaluate((t) => { window.__saralaVoiceScript = t; }, script);
    await tap(page);
    await page.waitForTimeout(ms);
    await tap(page);
    await page.waitForTimeout(350);
  };

  const pipes = async () => (await blocks(page))[1].split("\n")[0].split("|").length;
  const rowCount = async () => (await blocks(page))[1].split("\n").length;

  await say("new table 2 by 2");
  check(
    JSON.stringify(await blocks(page)) === JSON.stringify(["Notes.", "| Column 1 | Column 2 |\n| --- | --- |\n|    |    |\n|    |    |"]),
    `"new table 2 by 2" inserts a sized table (${JSON.stringify(await blocks(page))})`,
  );

  // "Add a row" lands the caret in the new (body) row, so "delete the row"
  // right after acts on that same row, not the header.
  await say("add a row");
  check(await rowCount() === 5, `"add a row" grows it (${JSON.stringify((await blocks(page))[1])})`);
  await say("delete the row");
  check(await rowCount() === 4, `"delete the row" shrinks it back (${JSON.stringify((await blocks(page))[1])})`);

  // "Add a column" lands the caret in the new column's header, so "delete
  // column" right after acts on that same column.
  const cols0 = await pipes();
  await say("add a column");
  check(await pipes() === cols0 + 1, `"add a column" grows it too (${JSON.stringify((await blocks(page))[1])})`);
  await say("delete column");
  check(await pipes() === cols0, `"delete column" shrinks it too (${JSON.stringify((await blocks(page))[1])})`);

  await say("align right");
  check(/---:/.test((await blocks(page))[1].split("\n")[1]), `"align right" aligns the column at the caret (${JSON.stringify((await blocks(page))[1])})`);

  // Outside a table: says so, changes nothing.
  await caretAtEnd(page, "Notes.");
  const before = await blocks(page);
  await say("add a row");
  check(JSON.stringify(await blocks(page)) === JSON.stringify(before), "outside a table, a table command is a no-op");
  check(await page.locator(".voice-status", { hasText: "Not in a table" }).count() === 1, "and says so");
  await page.close();
}

// ---- 6. Hands-free: type at each pause; stop at a pause ----
{
  const page = await newPage({ ...on, settings: { ...on.settings, voicePause: "type", voicePauseSeconds: 1 } });
  await store(page, (s) => s.openDocument("Log:", "/bench/voice6.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "Log:");
  await page.evaluate(() => { window.__saralaVoiceScript = "First thought. | Second thought."; window.__saralaVoicePauseTicks = 40; });
  await tap(page);
  await page.waitForTimeout(1500);
  check((await blocks(page))[0] === "Log: First thought." && (await page.locator(".voice-hud:not(.voice-notice)").count()) === 1, `a pause types what was said and keeps listening (${JSON.stringify((await blocks(page))[0])})`);
  check((await page.evaluate(() => window.__tones)).includes(990), "with a soft blip");
  await page.waitForTimeout(700);
  await tap(page);
  await page.waitForTimeout(300);
  check((await blocks(page))[0] === "Log: First thought. Second thought.", `the rest is typed on finishing (${JSON.stringify((await blocks(page))[0])})`);

  await page.evaluate(async () => { await (await import("/src/voice/config.ts")).setVoicePause("stop"); window.__saralaVoiceScript = "Done now."; });
  await tap(page);
  await page.waitForTimeout(1800);
  check(!(await page.locator(".voice-hud:not(.voice-notice)").count()), "with “type and stop”, a pause finishes on its own");
  check((await blocks(page))[0].endsWith("Done now."), "and types the words");

  await page.evaluate(async () => { await (await import("/src/voice/config.ts")).setVoicePause("type"); window.__saralaVoiceScript = "Part one. | Stop listening."; window.__saralaVoicePauseTicks = 30; });
  await tap(page);
  await page.waitForTimeout(3200);
  check(!(await page.locator(".voice-hud:not(.voice-notice)").count()), "“stop listening” ends hands-free dictation");
  check(!(await blocks(page))[0].toLowerCase().includes("stop listening"), "and isn't typed");
  await page.close();
}

// ---- 7. Shortcut behaviour, recorder, dead microphone, sandbox, old CPU ----
{
  const page = await newPage({ ...on, settings: { ...on.settings, voiceTrigger: "toggle" } });
  await store(page, (s) => s.openDocument("Toggle.", "/bench/voice7.md"));
  await page.waitForTimeout(300);
  await caretAtEnd(page, "Toggle.");
  await down(page); await page.waitForTimeout(800); await up(page); await page.waitForTimeout(200);
  check(await page.locator(".voice-hud:not(.voice-notice)").count() === 1, "press-to-toggle: a long press doesn't stop it");
  await tap(page); await page.waitForTimeout(300);
  check((await blocks(page))[0].endsWith("lazy dog."), "the next press does");

  await page.evaluate(async () => { await (await import("/src/voice/config.ts")).setVoiceTrigger("hold"); });
  await hold(page, 700);
  check(!(await page.locator(".voice-hud:not(.voice-notice)").count()), "hold-only: releasing stops");

  // Recorder.
  await page.evaluate(async () => (await import("/src/commands.ts")).executeCommand("voice.settings"));
  await page.waitForSelector(".voice-shortcut");
  const rec = page.locator(".voice-shortcut button", { hasText: "Record" });
  await rec.click();
  await page.keyboard.press("d");
  check(/Ctrl, Alt \(Option\) or Cmd/.test(await page.locator(".voice-shortcut-msg").textContent()), "a bare letter is refused, with the reason");
  await page.keyboard.press(`${mod}+z`);
  check(/already used for Edit > Undo/.test(await page.locator(".voice-shortcut-msg").textContent()), "a shortcut Sarala uses is refused, naming the command");
  await page.keyboard.press("Alt+Backquote");
  await page.waitForTimeout(200);
  const saved = await page.evaluate(async () => (await import("/src/voice/config.ts")).voiceShortcut());
  check(saved === "Alt+Backquote", `a free combination is recorded (${saved})`);
  await page.keyboard.press("Escape"); await page.waitForTimeout(150); await page.keyboard.press("Escape");
  await caretAtEnd(page, "Toggle.");
  await page.keyboard.down("Alt"); await page.keyboard.down("Backquote"); await page.waitForTimeout(700); await page.keyboard.up("Backquote"); await page.keyboard.up("Alt");
  await page.waitForTimeout(300);
  check((await blocks(page)).join(" ").split("lazy dog.").length >= 3, "the recorded shortcut works");

  // A microphone the OS silences.
  await page.evaluate(() => { window.__saralaVoiceDeadMic = true; window.__saralaVoiceSandbox = "snap"; });
  await page.evaluate(async () => { (await import("/src/voice/session.ts")).initVoice(); });
  await page.waitForTimeout(100);
  await page.evaluate(async () => (await import("/src/commands.ts")).executeCommand("voice.toggle"));
  await page.waitForTimeout(3200);
  const warn = await page.locator(".voice-hud-warning").textContent().catch(() => "");
  check(/No sound from the microphone/.test(warn) && /snap connect sarala:audio-record/.test(warn), `digital silence is explained, with the snap fix (${warn.slice(0, 80)}…)`);
  check(await page.locator(".voice-hud-warning button", { hasText: "Copy command" }).count() === 1, "and a button copies the command");
  await page.evaluate(async () => (await import("/src/commands.ts")).executeCommand("voice.cancel"));
  await page.close();
}
{
  const page = await newPage();
  await page.evaluate(() => { window.__saralaVoiceUnsupported = "Voice typing needs a processor with AVX2."; });
  await page.evaluate(async () => { await (await import("/src/voice/session.ts")).initVoice(); });
  await page.evaluate(async () => (await import("/src/commands.ts")).executeCommand("voice.setup"));
  await page.waitForSelector(".voice-setup");
  check(/AVX2/.test(await page.locator(".voice-setup-note").textContent()), "an unsupported computer is told why");
  check(await page.locator(".voice-setup .pandoc-btn.primary").isDisabled(), "and can't start a download");
  await page.close();
}

// ---- 4b. Never typed anywhere: a new paragraph ----
{
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Untouched.", "/bench/voice4b.md"));
  await page.waitForTimeout(300);
  await page.locator(".topbar-toggle.voice-top").click();
  await page.waitForTimeout(600);
  await page.locator(".topbar-toggle.voice-top").click();
  await page.waitForTimeout(300);
  const b = await blocks(page);
  check(b.length === 2 && b[1] === "The quick brown fox jumps over the lazy dog.", `with no caret ever, the words become a new paragraph (${JSON.stringify(b)})`);
  await page.close();
}

// ---- 4. The AI composer, and no caret at all ----
{
  const page = await newPage(on);
  await store(page, (s) => s.openDocument("Only block.", "/bench/voice3.md"));
  await page.waitForTimeout(300);
  await page.locator(".ai-rail-main").click();
  await page.waitForSelector(".ai-input");
  check(await page.locator(".ai-box-bar .voice-btn").count() === 1, "the AI composer has a mic button");
  await page.locator(".ai-input").click();
  await hold(page, 900);
  await page.waitForTimeout(200);
  check((await page.locator(".ai-input").inputValue()) === "The quick brown fox jumps over the lazy dog.", "dictation goes into the AI composer when it has focus");
  // Return while dictating into the composer finishes the dictation; it
  // doesn't send the message.
  await page.locator(".ai-input").fill("");
  await page.locator(".ai-input").focus();
  const sentBefore = await page.locator(".ai-user").count();
  await tap(page);
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  check((await page.locator(".ai-user").count()) === sentBefore && (await page.locator(".ai-input").inputValue()).length > 0,
    "Return finishes dictation in the composer without sending it");
  await page.locator(".ai-input").fill("");
  await page.locator(".ai-input").focus();
  await hold(page, 900);
  await page.waitForTimeout(200);
  check(await page.locator(".ai-send:not([disabled])").count() === 1, "and the composer sees the input (Send is enabled)");

  // Focus left the composer: the words still go back to where the caret was.
  await page.locator(".ai-input").evaluate((el) => el.blur());
  await page.evaluate(() => { window.__saralaVoiceScript = "And more."; });
  await page.locator(".topbar-toggle.voice-top").click();
  await page.waitForTimeout(500);
  await page.locator(".topbar-toggle.voice-top").click();
  await page.waitForTimeout(300);
  check((await page.locator(".ai-input").inputValue()) === "The quick brown fox jumps over the lazy dog. And more.", "after focus moves away, dictation goes back to where you were typing");

  // A keyboard or Voice Control user focuses the mic button and presses it.
  await caretAtEnd(page, "Only block.");
  await page.evaluate(() => { window.__saralaVoiceScript = "Pressed by name."; });
  await page.locator(".topbar-toggle.voice-top").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  await page.locator(".topbar-toggle.voice-top").focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  check((await blocks(page))[0] === "Only block. Pressed by name.", `pressing the focused mic button types at the remembered caret (${JSON.stringify(await blocks(page))})`);
  await page.close();
}

await browser.close();
kill();
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
