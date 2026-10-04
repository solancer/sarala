/**
 * Automated WCAG 2.2 AA scan (axe-core) of every major surface, in every
 * built-in theme: the editor with a rich document, sidebar views, Source
 * mode, each Settings section, command palette, Quick Open, find/replace,
 * dialogs, context menus, contextual toolbars, the in-app menubar
 * (Windows/Linux), the AI assistant's states, and voice typing.
 *
 *   node tests/e2e-a11y.mjs            # scan, fail on any violation
 *   node tests/e2e-a11y.mjs --themes=1 # only the default theme (faster)
 *
 * Automated checks cover only part of WCAG; keyboard, focus and screen
 * reader behaviour are exercised separately (see docs/UX-ACCESSIBILITY-AUDIT.md).
 */
import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { chromium } from "playwright";

const require = createRequire(import.meta.url);
const axeSource = await readFile(require.resolve("axe-core/axe.min.js"), "utf8");
const fixture = await readFile(new URL("./fixtures/kafka-guide.md", import.meta.url), "utf8");
const THEMES = ["sarala", "pro", "octagon", "machine", "ristretto", "spectrum", "classic", "paper", "graphite", "github", "night", "newsprint", "whitey"];
const themeCount = Number(process.argv.find((a) => a.startsWith("--themes="))?.slice(9) ?? THEMES.length);
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];
// Documented exceptions. Each names the WCAG clause that allows it.
const EXEMPT = [
  // 2.5.8 Target Size (Minimum), "Equivalent" exception: table drag handles
  // are pointer shortcuts; the table toolbar's 24px Move row/column buttons
  // (and the Table menu) do the same thing. Narrow columns place their
  // handles closer than 24px apart.
  { rule: "target-size", selector: ".table-drag-handle" },
];

const PORT = 1447;
const server = spawn("npx", ["vite", "--port", String(PORT)], { stdio: "pipe" });
const kill = () => { try { server.kill("SIGTERM"); } catch { /* gone */ } };
process.on("exit", kill);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("vite did not start")), 20000);
  server.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); } });
});

const browser = await chromium.launch();
const found = new Map(); // rule id -> { impact, help, where: Set }
let scans = 0;

async function newPage({ linux = false, settings = {} } = {}) {
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    reducedMotion: "reduce", // no mid-animation colours
    ...(linux ? { userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140 Safari/537.36" } : {}),
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("[pageerror]", e.message));
  await page.addInitScript((s) => localStorage.setItem("sarala.settings", JSON.stringify(s)), settings);
  await page.goto(`http://localhost:${PORT}`);
  await page.waitForSelector(".block");
  await page.addScriptTag({ content: axeSource });
  return page;
}

async function scan(page, state, include) {
  await page.waitForTimeout(250);
  const violations = await page.evaluate(async ({ include, tags, exempt }) => {
    const ctx = include ? { include: [...document.querySelectorAll(include)].map((el) => el) } : document;
    const r = await window.axe.run(ctx, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
    for (const v of r.violations) {
      v.nodes = v.nodes.filter((n) => !exempt.some((x) => x.rule === v.id && document.querySelector(n.target[0])?.matches(x.selector)));
    }
    return r.violations.filter((v) => v.nodes.length).map((v) => ({
      id: v.id, impact: v.impact, help: v.help,
      nodes: v.nodes.map((n) => `${n.target.join(" ")}${n.any[0]?.data?.contrastRatio ? ` (${n.any[0].data.contrastRatio}:1 ${n.any[0].data.fgColor}/${n.any[0].data.bgColor})` : ""}`),
    }));
  }, { include, tags: TAGS, exempt: EXEMPT });
  scans++;
  for (const v of violations) {
    const entry = found.get(v.id) ?? { impact: v.impact, help: v.help, where: new Map() };
    for (const n of v.nodes) entry.where.set(`${state}: ${n}`, true);
    found.set(v.id, entry);
  }
}

const cmd = (page, id) => page.evaluate(async (id) => (await import("/src/commands.ts")).executeCommand(id), id);
const escape = async (page) => { await page.keyboard.press("Escape"); await page.waitForTimeout(150); };

// ---- rich document, all themes ----
for (const theme of THEMES.slice(0, themeCount)) {
  const page = await newPage({ settings: { theme, aiEnabled: true, aiAgent: "mock" } });
  await page.evaluate(async (md) => (await import("/src/store.ts")).openDocument(md, "/bench/kafka-guide.md"), fixture);
  await page.waitForTimeout(1500);
  await scan(page, `${theme}/document`);
  await page.locator(".ai-rail-main").click();
  await scan(page, `${theme}/assistant-welcome`);
  await page.close();
}

// ---- every surface, default theme ----
{
  const page = await newPage({ settings: { aiEnabled: true, aiAgent: "mock" } });
  await page.evaluate(async (md) => (await import("/src/store.ts")).openDocument(md, "/bench/kafka-guide.md"), fixture);
  await page.waitForTimeout(1200);

  await cmd(page, "view.focus_mode"); await scan(page, "focus mode (rail recedes)"); await cmd(page, "view.focus_mode");
  for (const tab of ["view.outline", "view.file_tree"]) { await cmd(page, tab); await scan(page, `sidebar ${tab}`); }
  await cmd(page, "edit.replace"); await scan(page, "find/replace"); await escape(page);
  await cmd(page, "view.source_mode"); await scan(page, "source mode"); await cmd(page, "view.source_mode");
  await cmd(page, "menu.command_palette"); await page.keyboard.type("the"); await scan(page, "command palette"); await escape(page);
  await cmd(page, "file.open_quickly"); await scan(page, "quick open"); await escape(page);
  await cmd(page, "app.settings");
  const sections = await page.locator(".set-rail-item").allTextContents();
  for (const s of sections) {
    await page.locator(".set-rail-item", { hasText: s }).click();
    await scan(page, `settings/${s}`);
  }
  await escape(page);
  for (const [id, name] of [["themes.picker", "theme picker"], ["themes.custom", "theme editor"], ["help.about", "about"], ["paragraph.table.insert", "table dialog"], ["file.export.html", "export html dialog"]]) {
    await cmd(page, id); await page.waitForTimeout(300); await scan(page, name); await escape(page); await escape(page);
  }
  // Editor context menu, link card, selection toolbar + menus.
  const para = page.locator(".editor .page > .block").filter({ hasText: "Before Kafka" }).first();
  await para.click({ button: "right" }); await scan(page, "editor context menu"); await escape(page);
  const link = page.locator(".editor .page > .block a[href^='http']").first();
  if (await link.count()) { await link.hover(); await page.waitForTimeout(900); await scan(page, "link hover card"); await page.mouse.move(5, 5); }
  await para.click();
  // Line start: Cmd+Left on macOS (Home scrolls the document there).
  await page.keyboard.press(process.platform === "darwin" ? "Meta+ArrowLeft" : "Home"); await page.keyboard.down("Shift");
  for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift"); await page.waitForTimeout(250);
  await scan(page, "selection toolbar");
  await page.locator(".sel-bar .sel-ai .sel-type-btn").click(); await scan(page, "selection toolbar ai menu");
  await escape(page);
  await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.type("/");
  await page.waitForTimeout(300); await scan(page, "slash menu"); await escape(page);
  // Table tools.
  const table = page.locator(".editor .page > .block").filter({ has: page.locator("table") }).first();
  if (await table.count()) { await table.click(); await page.waitForTimeout(300); await scan(page, "table editing"); }
  await page.mouse.click(5, 400);

  // Assistant: proposals, agent menu, chats menu, blocked state.
  await page.locator(".ai-rail-main").click();
  await page.locator(".ai-suggest-card", { hasText: "Proofread" }).click();
  await page.waitForTimeout(1200);
  await scan(page, "assistant reply");
  await page.locator(".ai-switch-btn").click(); await scan(page, "assistant agent menu"); await escape(page);
  await page.locator(".ai-tabs-more button").click(); await scan(page, "assistant chats menu"); await escape(page);
  await page.close();
}
{
  const page = await newPage({});
  await page.locator(".ai-rail-main").click(); await scan(page, "assistant onboarding");
  await page.close();
}
// Voice typing: set-up dialog, listening HUD, warnings, settings (dev mock),
// in a light and a dark theme (it has its own recording red).
for (const theme of ["sarala", "night"]) {
  const page = await newPage({ settings: { theme } });
  await cmd(page, "voice.setup"); await page.waitForSelector(".voice-setup"); await scan(page, `${theme}/voice setup`);
  await page.locator(".voice-setup .pandoc-btn.primary").click();
  await page.waitForSelector("text=Voice typing is on", { timeout: 5000 }); await scan(page, `${theme}/voice setup ready`);
  await escape(page);
  await page.evaluate(() => { window.__saralaVoiceDelay = 400; });
  await page.locator(".editor .page > .block").first().click();
  await cmd(page, "voice.toggle"); await page.waitForSelector(".voice-hud", { timeout: 5000 }); await page.waitForTimeout(600); await scan(page, `${theme}/voice listening`);
  await cmd(page, "voice.cancel");
  // Command mode (the command key held) and the commands sheet.
  const cmdKey = process.platform === "darwin" ? "AltRight" : "ControlRight";
  await page.keyboard.down(cmdKey); await page.waitForTimeout(700);
  await scan(page, `${theme}/voice command mode`);
  await page.keyboard.up(cmdKey); await page.waitForTimeout(500); await escape(page);
  await cmd(page, "voice.commands"); await page.waitForSelector(".voice-commands"); await scan(page, `${theme}/voice commands sheet`); await escape(page);
  await page.evaluate(() => { window.__saralaVoiceDeadMic = true; });
  await cmd(page, "voice.toggle"); await page.waitForSelector(".voice-hud-warning", { timeout: 6000 }); await scan(page, `${theme}/voice silent-mic warning`);
  await cmd(page, "voice.cancel");
  await page.evaluate(() => { window.__saralaVoiceDeadMic = false; });
  await cmd(page, "voice.settings"); await page.waitForSelector(".voice-shortcut"); await scan(page, `${theme}/settings/voice`);
  await page.locator(".voice-shortcut button", { hasText: "Record" }).click(); await page.keyboard.press("d"); await scan(page, `${theme}/voice shortcut recorder error`);
  await escape(page); await escape(page);
  await page.evaluate(() => { window.__saralaVoicePermission = "denied"; });
  await cmd(page, "voice.toggle"); await page.waitForSelector(".voice-notice"); await scan(page, `${theme}/voice notice`);
  await page.close();
}
{
  const page = await newPage({ linux: true });
  await scan(page, "linux menubar");
  const first = page.locator(".menubar button, [role=menubar] [role=menuitem]").first();
  // Scoped to the menubar: the open dropdown covers sidebar buttons, which
  // target-size would otherwise count as crowded.
  if (await first.count()) { await first.click(); await scan(page, "linux menubar open", ".menubar, [role=menubar], [role=menu]"); }
  await page.close();
}

await browser.close();
kill();

let total = 0;
for (const [id, v] of [...found].sort((a, b) => ["critical", "serious", "moderate", "minor"].indexOf(a[1].impact) - ["critical", "serious", "moderate", "minor"].indexOf(b[1].impact))) {
  const where = [...v.where.keys()];
  total += where.length;
  console.log(`\n${v.impact.toUpperCase()} ${id}: ${v.help} (${where.length})`);
  for (const w of where.slice(0, 8)) console.log(`   ${w}`);
  if (where.length > 8) console.log(`   … ${where.length - 8} more`);
}
console.log(`\n${scans} scans, ${found.size} rule(s) violated, ${total} occurrence(s)`);
process.exit(found.size ? 1 : 0);
