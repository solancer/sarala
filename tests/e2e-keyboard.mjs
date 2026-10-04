/**
 * Keyboard accessibility (WCAG 2.1.1, 2.1.2, 2.4.3, 2.4.7): everything the
 * mouse can do has a keyboard path, focus is always visible and never
 * trapped, and it returns to where it was when a menu or dialog closes.
 *
 *   node tests/e2e-keyboard.mjs   (starts its own server on :1452)
 *
 * The automated WCAG scan is tests/e2e-a11y.mjs.
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";

const PORT = 1452;
const mod = process.platform === "darwin" ? "Meta" : "Control";
const fixture = await readFile(new URL("./fixtures/kafka-guide.md", import.meta.url), "utf8");
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
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", (e) => { console.log("[pageerror]", e.message); failures++; });
await page.addInitScript(() => localStorage.setItem("sarala.settings", JSON.stringify({ aiEnabled: true, aiAgent: "mock" })));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");
const store = (fn, arg) => page.evaluate(async ({ fn, arg }) => (0, eval)(fn)(await import("/src/store.ts"), arg), { fn: String(fn), arg });
await store((s, md) => s.openDocument(md, "/bench/kafka.md"), fixture);
await page.waitForTimeout(1000);
await page.locator(".ai-rail-main").click();
await page.waitForTimeout(300);

const focus = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a || a === document.body) return { id: "body", ring: false };
  const cs = getComputedStyle(a);
  const ring = (cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== "none";
  return { id: `${a.tagName.toLowerCase()}.${String(a.className).split(" ")[0]}${a.dataset.path ? `[${a.dataset.path}]` : ""}${a.getAttribute("aria-label") ? `[${a.getAttribute("aria-label")}]` : ""}`, ring, path: a.dataset.path };
});

// 1. Tab walk: no traps, every stop visibly focused.
await page.evaluate(() => document.activeElement?.blur());
const stops = [];
const noRing = [];
for (let i = 0; i < 80; i++) {
  await page.keyboard.press("Tab");
  const f = await focus();
  stops.push(f.id);
  if (f.id !== "body" && !f.ring) noRing.push(f.id);
}
check(new Set(stops).size > 12, `Tab reaches the app's controls (${new Set(stops).size} distinct stops)`);
check(stops.slice(40).some((s) => stops.slice(0, 20).includes(s)), "Tab cycles through the app (no keyboard trap)");
check(noRing.length === 0, `every Tab stop shows a focus indicator${noRing.length ? ` (missing: ${[...new Set(noRing)].join(", ")})` : ""}`);

// 2. Editor context menu from the keyboard.
await page.locator(".editor .page > .block").filter({ hasText: "Before Kafka" }).first().click();
await page.keyboard.press("Shift+F10");
await page.waitForTimeout(250);
check(await page.locator(".ctx-menu").isVisible(), "Shift+F10 opens the editor context menu");
check((await focus()).id.startsWith("button.ctx-item"), "focus moves into the menu");
const first = (await focus()).id;
await page.keyboard.press("ArrowDown");
check((await focus()).id.startsWith("button.ctx-item") && (await page.evaluate(() => document.activeElement.textContent)) !== first, "arrow keys move between items");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
check(!(await page.locator(".ctx-menu").isVisible()) && (await focus()).id.startsWith("div.source"), "Escape closes it and returns to the text");

// 3. Links from the keyboard.
await page.evaluate(() => { window.__opened = []; window.open = (u) => { window.__opened.push(String(u)); return null; }; });
await store((s) => s.openDocument("Intro.\n\nSee [the site](https://example.com) now.", "/bench/links.md"));
await page.waitForTimeout(300);
await page.locator(".editor .page > .block a").first().click();
await page.waitForTimeout(150);
await page.keyboard.press("Shift+F10");
await page.waitForTimeout(200);
const labels = await page.locator(".ctx-menu .ctx-label").allTextContents();
check(["Open Link", "Copy Link Address", "Remove Link"].every((l) => labels.includes(l)), "the context menu offers link actions at the cursor");
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await page.keyboard.press(`${mod}+Enter`);
await page.waitForTimeout(200);
check((await page.evaluate(() => window.__opened)).includes("https://example.com"), "Cmd/Ctrl+Enter opens the link at the cursor");

// 4. Focus returns after the command palette closes.
await page.locator(".ai-input").focus();
await page.keyboard.press(`${mod}+k`);
await page.waitForTimeout(250);
check((await focus()).id.startsWith("input"), "the command palette takes focus");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check((await focus()).id.startsWith("textarea.ai-input"), "and gives it back on Escape");

// 4b. Edit shortcuts belong to a focused text field, not the document.
await page.locator(".ai-input").fill("draft question");
await page.locator(".ai-input").focus();
await page.keyboard.press(`${mod}+a`);
await page.waitForTimeout(150);
const sel = await page.evaluate(() => {
  const a = document.activeElement;
  return { cls: a?.className, start: a?.selectionStart, end: a?.selectionEnd, len: a?.value?.length, inDoc: !!document.querySelector(".editor .page")?.contains(window.getSelection()?.anchorNode ?? null) };
});
check(String(sel.cls).includes("ai-input") && sel.start === 0 && sel.end === sel.len && !sel.inDoc, `Cmd/Ctrl+A in a text field selects the field, not the document (${JSON.stringify(sel)})`);
await page.locator(".ai-input").fill("");

// 5. A large, windowed file tree: one Tab stop, and navigation reaches rows
//    that aren't rendered.
await store((s) => {
  const files = Array.from({ length: 600 }, (_, i) => {
    const n = String(i).padStart(3, "0");
    return { name: `note-${n}.md`, path: `/w/note-${n}.md`, is_dir: false };
  });
  s.setFileTree([{ name: "docs", path: "/w/docs", is_dir: true, children: [{ name: "a.md", path: "/w/docs/a.md", is_dir: false }] }, ...files]);
  s.setFolderName("w");
  s.setFolderPath("/w");
});
await page.waitForTimeout(300);
check((await page.locator('[role="treeitem"][tabindex="0"]').count()) === 1, "the file tree is a single Tab stop");
await page.locator('[role="treeitem"]').first().focus();
await page.keyboard.press("End");
await page.waitForTimeout(200);
check((await focus()).path === "/w/note-599.md", "End reaches the last row, beyond the rendered window");
await page.keyboard.press("Home");
for (let i = 0; i < 150; i++) await page.keyboard.press("ArrowDown");
await page.waitForTimeout(200);
check((await focus()).path === "/w/note-149.md", "a long run of ArrowDown lands on the right row");
for (const ch of "note-45") await page.keyboard.press(ch);
check((await focus()).path === "/w/note-450.md", "type-ahead finds a row outside the window");
await page.keyboard.press("Home");
await page.keyboard.press("ArrowRight");
await page.waitForTimeout(150);
check((await focus()).path === "/w/docs", "ArrowRight opens a folder and keeps focus on it");
await page.keyboard.press("ArrowRight");
check((await focus()).path === "/w/docs/a.md", "ArrowRight again moves into it");
await page.keyboard.press("ArrowLeft");
check((await focus()).path === "/w/docs", "ArrowLeft returns to the parent");
await page.keyboard.press("Tab");
check(!(await focus()).path, "Tab leaves the tree in one step");

await browser.close();
kill();
console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
process.exit(failures ? 1 : 0);
