/**
 * Voice typing with nothing mocked: real model download, real microphone path
 * (Chrome's fake device playing a recording), real recognition. Needs network
 * the first time, and a recording of speech:
 *
 *   say -o speech.wav --data-format=LEI16@48000 --channels=1 "The quick brown fox..."
 *   SPEECH=speech.wav node tests/e2e-voice.mjs
 *   NO_GPU=1 SPEECH=speech.wav node tests/e2e-voice.mjs
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

// APP_URL=http://localhost:1421 tests a server that is already running.
const PORT = 1426;
const APP_URL = process.env.APP_URL ?? `http://localhost:${PORT}/`;
if (!process.env.APP_URL) {
  const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
    cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
  });
  process.on("exit", () => server.kill());
  await new Promise((r) => server.stdout.on("data", (d) => String(d).includes("Local") && r()));
}

const browser = await chromium.launch({
  channel: "chrome",
  args: [
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${process.env.SPEECH}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["microphone"] });
// NO_GPU=1 takes the WASM path, which is what Firefox and Safari get.
if (process.env.NO_GPU) await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined }));
const page = await context.newPage();
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
page.on("crash", () => console.log("[page crash]"));
page.on("close", () => console.log("[page closed]"));
browser.on("disconnected", () => console.log("[browser gone]"));
page.on("worker", (w) => console.log("[worker]", w.url().split("/").pop()));
page.on("console", (m) => { if (m.type() === "error" && !/favicon/.test(m.text())) console.log("[console]", m.text().slice(0, 300)); });
page.on("dialog", (d) => { console.log("[dialog]", d.message().slice(0, 200)); void d.accept(); });
await page.goto(APP_URL);
await page.waitForSelector(".block");
await page.waitForTimeout(1200);
console.log("adapter:", await page.evaluate(async () => {
  const a = await navigator.gpu?.requestAdapter();
  return a ? { fallback: a.isFallbackAdapter ?? a.info?.isFallbackAdapter, vendor: a.info?.vendor, arch: a.info?.architecture } : null;
}));

await page.keyboard.press("Control+k");
await page.locator('[aria-modal="true"] input').first().fill("Set Up Voice Typing");
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForTimeout(600);

const dialog = page.locator('[aria-modal="true"]').last();
// VOICE_LANGUAGE=Spanish takes the multilingual model, Whisper.
if (process.env.VOICE_LANGUAGE) await dialog.locator("select").first().selectOption({ label: process.env.VOICE_LANGUAGE });
const step = async () => (await dialog.innerText()).replace(/\s+/g, " ").slice(0, 400);
const started = Date.now();
let last = "";
for (let i = 0; i < 400; i++) {
  const text = await step().catch(() => "");
  if (text !== last) { console.log(`[${((Date.now() - started) / 1000).toFixed(1)}s]`, text.slice(-90)); last = text; }
  if (!(await page.locator('[aria-modal="true"]').count())) break;
  if (/Done|done/.test(await dialog.locator("button.primary:not(:disabled)").last().innerText().catch(() => ""))) {
    await dialog.locator("button.primary:not(:disabled)").last().click();
    await page.waitForTimeout(500);
    break;
  }
  const next = dialog.locator("button.primary:not(:disabled)").last();
  if (await next.count()) await next.click().catch(() => {});
  await page.waitForTimeout(700);
}
console.log("setup closed after", ((Date.now() - started) / 1000).toFixed(1), "s");
const settings = await page.evaluate(() => JSON.parse(localStorage.getItem("sarala.settings") ?? "{}"));
console.log("model:", settings.voiceModel, "enabled:", settings.voiceEnabled);

await page.locator(".document-tab-new").click();
await page.waitForTimeout(300);
await page.keyboard.press("Control+k");
await page.locator('[aria-modal="true"] input').first().fill("Voice Typing: Start");
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForTimeout(9000);
const midway = (await page.locator(".block").allInnerTexts()).join(" ");
console.log("WHILE SPEAKING:", JSON.stringify(midway.slice(0, 100)));
const live = /quick|brown|lazy|dog/i.test(midway) || (!!process.env.VOICE_LANGUAGE && midway.trim().length > 10);
console.log(live ? "PASS: the words appear while speaking" : "FAIL: nothing appeared while speaking");
await page.keyboard.press("Control+k").catch(() => {});
await page.locator('[aria-modal="true"] input').first().fill("Voice Typing: Start");
await page.waitForTimeout(150);
await page.keyboard.press("Enter");
await page.waitForTimeout(12000);
const typed = (await page.locator(".block").allInnerTexts()).join(" ");
console.log("TYPED:", JSON.stringify(typed));
// The recording loops, and a synthetic voice is hard: "fox" often comes out wrong.
const ok = live && /quick brown|quick, brown/i.test(typed) || (!!process.env.VOICE_LANGUAGE && typed.trim().length > 10);
console.log(ok ? "PASS: speech became text" : "FAIL: no text");
await browser.close();
process.exit(ok ? 0 : 1);
