/**
 * The web build, end to end: production bundle, service worker, real IndexedDB,
 * real pandoc.wasm, real file handles.
 *
 *   pnpm --filter sarala-web build && pnpm --filter sarala-web test
 *
 * A "folder on this device" needs a native picker no test can click, so the
 * picker is stubbed to return a directory in the Origin Private File System.
 * That is a genuine FileSystemDirectoryHandle: createWritable, its swap-file
 * commit and lastModified all run for real.
 */
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { unzipSync, strFromU8 } from "fflate";

const PORT = 1424;
const URL_ = `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOTS;

const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
});
process.on("exit", () => server.kill());
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("preview did not start")), 20000);
  server.stdout.on("data", (d) => { if (String(d).includes("Local")) { clearTimeout(timer); resolve(); } });
});

let failures = 0;
let passes = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}${!ok && detail ? ` -- ${detail}` : ""}`);
  if (ok) passes++; else failures++;
};
const section = (name) => console.log(`\n== ${name}`);

// Real Chrome: Playwright's headless shell crashes outright when it reads a
// file handle back out of IndexedDB, with or without this app.
const browser = await chromium.launch({ channel: "chrome" });
const dir = mkdtempSync(join(tmpdir(), "sarala-web-"));

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC", "base64");

async function open(context) {
  const page = await context.newPage();
  page.problems = [];
  page.on("pageerror", (e) => page.problems.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !/Failed to load resource/.test(m.text())) page.problems.push(m.text().slice(0, 400));
    if (/Content.Security.Policy|violates/i.test(m.text())) page.problems.push(`CSP: ${m.text().slice(0, 400)}`);
  });
  page.on("dialog", (d) => { (page.dialogs ??= []).push(d.message()); void d.accept(); });
  await page.goto(URL_);
  await page.waitForSelector(".block", { timeout: 20000 });
  return page;
}

const tree = (page) => page.locator(".sidebar [data-path]").evaluateAll((e) => e.map((x) => x.dataset.path));
const tabs = (page) => page.locator(".document-toolbar [role=tab]").allInnerTexts().then((t) => t.map((s) => s.trim().replace(/\s+.*$/s, "")));
const settle = (page, ms = 800) => page.waitForTimeout(ms);

async function palette(page, text) {
  await page.keyboard.press("Control+k");
  const input = page.locator('[aria-modal="true"] input').first();
  await input.fill(text);
  await page.waitForTimeout(100);
  await page.keyboard.press("Enter");
}

/** Click through the Menu: a submenu, then an item. */
async function menu(page, ...path) {
  await page.locator(".web-menu .web-bar-btn").click();
  for (const label of path.slice(0, -1)) await page.locator(".web-menu .menu-item").filter({ hasText: label }).first().hover();
  await page.locator(".web-menu .menu-item").filter({ hasText: path[path.length - 1] }).first().click();
}

async function newDoc(page, text) {
  await page.locator(".document-tab-new").click();
  await settle(page, 200);
  await page.keyboard.type(text);
  await settle(page, 200);
}

async function saveAs(page, name) {
  await page.keyboard.press("Control+s");
  const field = page.locator("#web-path-name");
  await field.waitFor();
  await field.fill(name);
  await page.keyboard.press("Enter");
  await field.waitFor({ state: "detached" });
  await settle(page, 300);
}

const downloadOf = async (page, action) => {
  const [d] = await Promise.all([page.waitForEvent("download", { timeout: 120000 }), action()]);
  const path = join(dir, d.suggestedFilename());
  await d.saveAs(path);
  return { name: d.suggestedFilename(), bytes: readFileSync(path) };
};

/* ---------------------------------------------------------------- */
section("first run");
const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
await context.addInitScript(() => {
  // A permission the browser has dropped, as it does after a restart.
  const { queryPermission } = FileSystemHandle.prototype;
  FileSystemHandle.prototype.queryPermission = function (...args) {
    return localStorage.getItem("test-denied") ? Promise.resolve("prompt") : queryPermission.apply(this, args);
  };
  FileSystemHandle.prototype.requestPermission = async () => { localStorage.removeItem("test-denied"); return "granted"; };
  // See the header: a real handle, from a stubbed picker.
  window.showDirectoryPicker = async () => {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("Project", { create: true });
  };
});
const page = await open(context);
await settle(page, 2500);
check((await page.title()).startsWith("Welcome.md"), "the welcome document opens");
check((await tree(page)).includes("/Library/Welcome.md"), "it is listed in the library");
check(await page.locator(".block .katex").count() > 0, "math renders");
check(await page.locator(".block .mermaid svg, .block svg[id^=mermaid], .mermaid-block svg").count() > 0, "a mermaid diagram renders under the CSP");
check(await page.locator(".block pre.shiki, .block .shiki").count() > 0, "code is highlighted");
check((await page.evaluate(() => document.querySelector(".app").classList.contains("is-web"))), "the app knows it is the web build");
if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-welcome.png` });

section("menus hide what a browser can't do");
check(await page.locator(".menubar").count() === 0, "no desktop menu bar");
const menuButton = page.locator(".web-menu .web-bar-btn");
await menuButton.click();
const rootMenu = await page.locator(".web-menu .menu-dropdown").first().innerText();
for (const row of ["New Document", "Open", "Import", "Rename or Move", "Duplicate", "Export", "Delete", "Back Up Library", "Settings"]) check(rootMenu.includes(row), `Menu has ${row}`, rootMenu);
check(!/Always on Top|AI Assistant|Voice Typing/.test(rootMenu), "nothing a browser can't do");
await page.locator(".web-menu .menu-item").filter({ hasText: "Blocks" }).first().hover();
await settle(page, 150);
const flyout = await page.locator(".web-menu .menu-sub .menu-dropdown").first().boundingBox();
check(flyout && flyout.y >= 0 && flyout.y + flyout.height <= 860, "a long submenu stays on the page", JSON.stringify(flyout));
await page.keyboard.press("Escape");
check(await page.locator(".web-menu .menu-dropdown").count() === 0, "Escape closes the Menu");
await menuButton.click();
await page.mouse.click(1100, 700);
check(await page.locator(".web-menu .menu-dropdown").count() === 0, "so does clicking away");
await page.locator(".web-export .web-bar-btn").click();
const exportMenu = await page.locator(".web-export .menu-dropdown").innerText();
await page.locator(".web-export .web-bar-btn").click();
check(/PDF/.test(exportMenu) && /Word/.test(exportMenu) && /Markdown/.test(exportMenu), "Export is a visible button", exportMenu);
check(/Draft|Saved|Edited/.test(await page.locator(".web-save").innerText()), "the save state shows where the document is");
check(await page.getByRole("button", { name: "Undo" }).first().isVisible(), "Undo is on the bar");
check(!(await page.locator(".web-menu .web-bar-btn").textContent()).includes("Ctrl"), "the Menu button is a word");
await menuButton.click();
check(!/New Document[^]*Ctrl\+N/.test((await page.locator(".web-menu .menu-dropdown").first().innerText()).split("Open")[0]), "no shortcut the tab keeps for itself");
await menuButton.click();
await page.keyboard.press("Control+k");
await page.locator('[aria-modal="true"] input').first().fill("AI");
await settle(page, 200);
const aiHits = await page.locator('[aria-modal="true"]').innerText();
await page.keyboard.press("Escape");
check(!/Review Document with AI|Toggle AI/.test(aiHits), "no AI commands in the palette");
check(await page.locator(".ai-rail").count() === 0, "no AI rail");

section("save, rename, delete in the library");
await newDoc(page, "First note in the library");
await saveAs(page, "notes/first.md");
await page.keyboard.type(" and on");
await settle(page, 200);
check((await page.locator(".block").allInnerTexts()).join(" ").includes("in the library and on"), "typing carries on where it left off after the save dialog");
const firstTree = await tree(page);
check(firstTree.some((p) => p.endsWith("notes-first.md")), "a slash in a name can't escape its folder", firstTree.join());

const scratch = await page.locator(".document-toolbar [role=tab]").count();
await newDoc(page, "Temporary");
await saveAs(page, "temp.md");
await page.evaluate(() => { document.activeElement?.blur?.(); });
await palette(page, "Rename");
await page.locator("#web-path-name").fill("renamed.md");
await page.keyboard.press("Enter");
await settle(page, 500);
let names = await tree(page);
check(names.includes("/Library/renamed.md") && !names.includes("/Library/temp.md"), "rename moves the file", names.join());
check((await page.title()).startsWith("renamed.md"), "and the open tab follows it");
await palette(page, "Delete…");
await settle(page, 500);
names = await tree(page);
check(!names.includes("/Library/renamed.md"), "delete removes it", names.join());
check(await page.locator(".document-toolbar [role=tab]").count() === scratch, "and closes its tab");

section("reload keeps everything");
page.dialogs = [];
await page.locator(".block").first().click();
await page.keyboard.press("End");
await page.keyboard.type(" edited but not saved");
await newDoc(page, "Never saved anywhere");
await settle(page, 900);
await page.reload();
await page.waitForSelector(".block");
await settle(page, 1000);
const reloaded = await tabs(page);
check(reloaded.length === 3, "every tab came back", reloaded.join());
const bodyAfter = await page.locator(".block").allInnerTexts();
check(bodyAfter.join(" ").includes("Never saved anywhere"), "an untitled document survives a reload");
check(!page.dialogs?.length, "no recovery prompt interrupts it", page.dialogs?.join());
await page.locator(".document-toolbar [role=tab]").nth(1).click();
await settle(page, 300);
check((await page.locator(".block").allInnerTexts()).join(" ").includes("edited but not saved"), "unsaved edits to a saved file survive a reload");
check(/Edited/.test(await page.title()), "and it is still marked as edited");

// A new page can start before the old one has let go of its session.
const before = await tabs(page);
let kept = true;
for (let i = 0; i < 8; i++) {
  await page.reload({ waitUntil: "commit" });
  await page.waitForSelector(".block");
  await settle(page, 80);
}
await settle(page, 1200);
kept = (await tabs(page)).join() === before.join();
check(kept, "eight quick reloads in a row lose nothing", (await tabs(page)).join());

section("a pasted image");
await newDoc(page, "Image test");
await saveAs(page, "pics.md");
await page.keyboard.press("Enter");
await page.keyboard.press("Enter");
await settle(page, 200);
await page.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([bytes], "image.png", { type: "image/png" }));
  const target = document.activeElement;
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}, PNG.toString("base64"));
await settle(page, 700);
await page.locator(".scroll").click({ position: { x: 5, y: 5 }, force: true });
await settle(page, 600);
const shown = () => page.locator(".block img").evaluateAll((imgs) => imgs.map((i) => ({ src: i.src, w: i.naturalWidth })));
let images = await shown();
check(images.length === 1 && images[0].src.startsWith("blob:") && images[0].w === 10, "it renders from a blob: URL", JSON.stringify(images));
await settle(page, 900);
await page.reload();
await page.waitForSelector(".block");
await settle(page, 1200);
images = await shown();
check(images.length === 1 && images[0].w === 10, "it renders again after a reload", JSON.stringify(images));

section("dropped files");
await page.evaluate((b64) => {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const data = new DataTransfer();
  data.items.add(new File([bytes], "dropped.png", { type: "image/png" }));
  document.querySelector(".page, .scroll").dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
}, PNG.toString("base64"));
await settle(page, 900);
await page.locator(".scroll").click({ position: { x: 5, y: 5 }, force: true });
await settle(page, 700);
images = await shown();
check(images.length === 2 && images.every((i) => i.w === 10), "a dropped image lands in the document", JSON.stringify(images));
await page.evaluate(() => {
  const data = new DataTransfer();
  data.items.add(new File(["# Dropped note\n"], "dropped.md", { type: "text/markdown" }));
  document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
});
await settle(page, 700);
check((await page.title()).startsWith("dropped.md"), "a dropped Markdown file opens", await page.title());
await page.locator(".document-toolbar [role=tab]").filter({ hasText: "pics.md" }).click();
await settle(page, 400);

section("export");
const html = await downloadOf(page, async () => {
  await palette(page, "Export as HTML");
  await page.locator(".export-dialog").getByRole("button", { name: "With outline" }).click();
});
const htmlText = html.bytes.toString("utf8");
check(html.name === "pics.html", "HTML arrives as a download", html.name);
check(/<img[^>]+src="data:image\/png;base64,/.test(htmlText), "images are embedded in it, not left as blob: URLs");
check(!htmlText.includes('src="blob:'), "no blob: URL leaks into the export");
const md = await downloadOf(page, () => palette(page, "Download Markdown"));
check(md.bytes.toString("utf8").startsWith("Image test"), "Download Markdown gives the source", md.bytes.toString("utf8").slice(0, 60));
const printed = await page.evaluate(async () => {
  const seen = { html: "" };
  const add = Element.prototype.appendChild;
  document.body.appendChild = function (el) {
    if (el.tagName === "IFRAME") { seen.html = el.srcdoc; el.addEventListener("load", () => { el.contentWindow.print = () => {}; }, { capture: true }); }
    return add.call(this, el);
  };
  window.__seen = seen;
  return true;
});
await palette(page, "Export as PDF");
await settle(page, 1500);
const pdfHtml = await page.evaluate(() => window.__seen.html);
check(printed && pdfHtml.includes("@page") && pdfHtml.includes("data:image/png"), "PDF goes through a print frame with page CSS and inline images", pdfHtml.slice(0, 100));

section("the palette keeps the block and selection");
await newDoc(page, "Make this bold");
for (let i = 0; i < 4; i++) await page.keyboard.press("Shift+ArrowLeft");
await palette(page, "Bold");
await settle(page, 300);
const boldText = (await page.locator(".block").allInnerTexts()).join("|");
check(/\*\*bold\*\*/.test(boldText) || await page.locator(".block strong").filter({ hasText: "bold" }).count() > 0, "Bold from the palette formats the selection", boldText);

section("rename on the tab");
await newDoc(page, "Rename me");
await saveAs(page, "tab-name.md");
await page.locator(".document-tab.selected [role=tab]").dblclick();
await page.locator(".document-tab-rename").fill("renamed-on-tab");
await page.keyboard.press("Enter");
await settle(page, 500);
check((await tree(page)).includes("/Library/renamed-on-tab.md"), "the name is edited where it sits", (await tree(page)).join());
await page.locator(".document-tab.selected [role=tab]").dblclick();
await page.locator(".document-tab-rename").fill("nope");
await page.keyboard.press("Escape");
await settle(page, 300);
check((await tree(page)).includes("/Library/renamed-on-tab.md"), "Escape leaves it alone");

section("on a phone");
{
  const phone = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const p = await phone.newPage();
  await p.goto(URL_);
  await p.waitForSelector(".block");
  await settle(p, 800);
  const width = await p.evaluate(() => [document.documentElement.scrollWidth, innerWidth]);
  check(width[0] <= width[1], "no sideways scrolling", width.join());
  check(await p.locator(".document-tabs").isHidden() && await p.locator(".web-docname").isVisible(), "the document name replaces the tabs");
  await p.locator(".web-menu .web-bar-btn").tap();
  await settle(p, 300);
  const sheetBox = await p.locator(".web-sheet").boundingBox();
  check(sheetBox.width === 390 && sheetBox.height >= 770, "Menu is a full-height sheet", JSON.stringify(sheetBox));
  const small = await p.locator(".web-sheet-row").evaluateAll((rows) => rows.filter((r) => r.getBoundingClientRect().height < 44).length);
  check(small === 0, "with targets big enough for a thumb");
  await p.locator(".web-sheet-row").filter({ hasText: "Export" }).first().tap();
  await settle(p, 200);
  check(/Word/.test(await p.locator(".web-sheet").innerText()), "submenus open in place");
  await p.getByRole("button", { name: "Back" }).tap();
  await p.getByRole("button", { name: "Close" }).tap();
  await settle(p, 200);
  await p.locator(".block").first().tap();
  await settle(p, 300);
  check(await p.locator(".web-keybar").isVisible(), "editing shows the bar above the keyboard");
  await p.keyboard.type("x");
  await p.getByRole("button", { name: "More" }).tap();
  await settle(p, 200);
  await p.locator(".web-sheet-row").filter({ hasText: "Blocks" }).tap();
  await p.locator(".web-sheet-row").filter({ hasText: "Quote" }).tap();
  await settle(p, 400);
  check((await p.locator(".block").allInnerTexts()).join("|").length > 0 && await p.locator(".block blockquote, .block .md-quote, .source").count() > 0, "a block command from the sheet still has its block");
  await phone.close();
}

section("legacy encodings (Rust in WebAssembly)");
const sjis = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67, 0x0a, 0x82, 0xb1, 0x82, 0xea, 0x82, 0xcd, 0x53, 0x68, 0x69, 0x66, 0x74, 0x5f, 0x4a, 0x49, 0x53, 0x82, 0xc5, 0x82, 0xb7, 0x0a]);
await page.evaluate(() => { window.showOpenFilePicker = undefined; });
const [chooser] = await Promise.all([page.waitForEvent("filechooser"), palette(page, "Open…")]);
await chooser.setFiles({ name: "legacy.md", mimeType: "text/markdown", buffer: sjis });
await settle(page, 1000);
const legacy = (await page.locator(".block").allInnerTexts()).join(" ");
check(legacy.includes("日本語のテキスト"), "Shift_JIS is detected and decoded", legacy.slice(0, 60));
const status = await page.locator(".statusbar").innerText();
check(/Shift_JIS/i.test(status), "the status bar names it", status);
await page.locator(".block").first().click();
await page.keyboard.press("End");
await page.keyboard.type("!");
await page.keyboard.press("Control+s");
await settle(page, 700);
const round = await downloadOf(page, () => palette(page, "Download Markdown"));
check(round.bytes.includes(Buffer.from([0x93, 0xfa, 0x96, 0x7b])), "saving writes Shift_JIS back, not UTF-8");

section("a real folder on this device");
await page.getByRole("button", { name: "Open folder", exact: true }).click();
await settle(page, 600);
check((await tree(page)).some((p) => p === "/Folders/Project"), "it joins the workspace tree", (await tree(page)).join());
await newDoc(page, "Written to a real file handle");
await page.keyboard.press("Control+s");
await page.locator("#web-path-name").fill("real.md");
await page.locator("#web-path-folder").selectOption("/Folders/Project");
await page.keyboard.press("Enter");
await settle(page, 800);
const onDisk = await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle("Project");
  return (await (await folder.getFileHandle("real.md")).getFile()).text();
});
check(onDisk.startsWith("Written to a real file handle"), "saving reaches the actual file", onDisk);
await page.evaluate(async () => {
  const root = await navigator.storage.getDirectory();
  const folder = await root.getDirectoryHandle("Project");
  const out = await (await folder.getFileHandle("real.md")).createWritable();
  await out.write("Changed by another program\n");
  await out.close();
  const other = await (await folder.getFileHandle("other.md", { create: true })).createWritable();
  await other.write("New file from outside\n");
  await other.close();
});
await page.waitForSelector(".conflict-banner, [class*=conflict]", { timeout: 9000 }).catch(() => {});
check(await page.locator(".conflict-banner, [class*=conflict]").count() > 0, "an outside edit raises the conflict banner");
await settle(page, 4500);
await page.locator('.sidebar [data-path="/Folders/Project"]').click();
await settle(page, 300);
check((await tree(page)).includes("/Folders/Project/other.md"), "an outside file appears in the tree", (await tree(page)).join());
await page.reload();
await page.waitForSelector(".block");
await settle(page, 1200);
check((await tree(page)).includes("/Folders/Project/real.md"), "the folder is still there, expanded, after a reload", (await tree(page)).join());

section("search across the workspace");
await page.getByRole("tab", { name: "Search" }).click();
const searchBox = page.locator(".search-input");
check((await searchBox.getAttribute("placeholder")) === "Search all documents…", "the field says what it searches", await searchBox.getAttribute("placeholder"));
const search = async (text) => { await searchBox.fill(text); await settle(page, 600); };
const findCount = () => page.locator(".findbar-count").innerText();
const summary = () => page.locator(".search-summary").innerText();
await search("library");
const results = await page.locator(".sidebar").innerText();
check(/notes-first\.md/.test(results) && /Welcome\.md/.test(results), "finds text inside files across the library", results.slice(0, 160));

await newDoc(page, "Needle one");
for (const line of ["filler", "needle two", "filler", "needle three"]) {
  await page.keyboard.press("Enter");
  await page.keyboard.type(line);
}
await settle(page, 300);
await saveAs(page, "haystack.md");
await search("needle");
check(/^3 matches in 1 file$/.test(await summary()), "counts the matches", await summary());
await page.locator(".search-hit").nth(2).click();
await settle(page, 500);
check((await findCount()) === "3 / 3", "a clicked line lands on that match", await findCount());
await page.locator(".search-hit").nth(1).click();
await settle(page, 500);
check((await findCount()) === "2 / 3", "another line in the same document lands there too", await findCount());

await page.getByRole("button", { name: "Match case" }).first().click();
await settle(page, 600);
await page.locator(".search-hit").first().click();
await settle(page, 500);
check((await findCount()) === "1 / 2", "the find bar takes the search's Match case", await findCount());
await page.getByRole("button", { name: "Match case" }).first().click();
await page.getByRole("button", { name: "Use regular expression" }).first().click();
await search("ne+dle");
await page.locator(".search-hit").last().click();
await settle(page, 500);
check((await findCount()) === "3 / 3", "a regular expression still finds its match in the document", await findCount());
await page.keyboard.press("Escape");
await search("(");
check((await summary()) === "Invalid pattern", "a broken pattern says so, not No matches", await summary());
await page.getByRole("button", { name: "Use regular expression" }).first().click();

await search("haystack");
check((await summary()) === "1 file by name", "a filename match is not reported as No matches", await summary());
await page.locator(".search-file-head").first().click();
await settle(page, 300);
check(!(await page.locator(".findbar-count").isVisible()), "a file found by name opens without an empty find bar");
await search("qqnomatchqq");
check((await summary()) === "No matches", "nothing found still says so", await summary());

await page.locator(".block").last().click();
await page.keyboard.press("End");
await page.keyboard.type(" zebra");
await search("zebra");
check(/^1 match in 1 file$/.test(await summary()) && /haystack\.md/.test(await page.locator(".search-panel").innerText()), "finds unsaved text in an open document", await summary());
await page.keyboard.press("Control+s");
await settle(page, 900);
check(/^1 match in 1 file$/.test(await summary()), "still finds it once saved", await summary());
await newDoc(page, "giraffe in a draft");
await search("giraffe");
check(/Untitled\.md/.test(await page.locator(".search-panel").innerText()), "finds an unsaved draft", await summary());
await page.locator(".search-hit").first().click();
await settle(page, 500);
check((await findCount()) === "1 / 1", "a draft opens at the match", await findCount());
await page.keyboard.press("Escape");
await page.locator(".document-toolbar [role=tab]").filter({ hasText: "Untitled" }).locator("button").last().click().catch(() => {});
await settle(page, 300);
if (await page.getByRole("button", { name: /Don.t Save|Discard/ }).count()) await page.getByRole("button", { name: /Don.t Save|Discard/ }).first().click();
await settle(page, 300);

await page.getByRole("tab", { name: "Files" }).click();
await palette(page, "search all");
await settle(page, 300);
check(await page.evaluate(() => document.activeElement?.classList.contains("search-input")), "the palette's Search All Documents opens the panel, not the find bar");
await page.getByRole("tab", { name: "Files" }).click();
await page.locator(".block").first().click();
await page.keyboard.press("Control+Shift+f");
await settle(page, 300);
check(await page.evaluate(() => document.activeElement?.classList.contains("search-input")), "its shortcut does too");

await page.evaluate(() => localStorage.setItem("test-denied", "1"));
await page.reload();
await page.waitForSelector(".block");
await settle(page, 1200);
await page.getByRole("tab", { name: "Search" }).click();
await search("new file from outside");
const beforeReconnect = await page.locator(".search-panel").innerText();
check(/Not searched: Project/.test(beforeReconnect) && !/other\.md/.test(beforeReconnect), "a folder without permission is named as not searched", beforeReconnect.slice(0, 120));
await page.locator(".search-blocked button").click();
await settle(page, 900);
const afterReconnect = await page.locator(".search-panel").innerText();
check(!/Not searched/.test(afterReconnect) && /other\.md/.test(afterReconnect), "Reconnect searches it straight away", afterReconnect.slice(0, 120));
await page.getByRole("tab", { name: "Files" }).click();

section("a very long block");
const longContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const long = await open(longContext);
await settle(long, 800);
const longList = Array.from({ length: 3000 }, (_, i) => `- item ${i} & <b>`);
await long.evaluate((text) => {
  const data = new DataTransfer();
  data.items.add(new File([text], "long.md", { type: "text/markdown" }));
  window.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
}, longList.join("\n") + "\n\nThe last paragraph");
await long.waitForFunction(() => /long\.md/.test(document.title));
await settle(long, 500);
const longSource = async () => {
  await long.locator(".view-toggle button", { hasText: "Source" }).click();
  await settle(long, 200);
  const text = await long.locator(".source-full").inputValue();
  await long.locator(".view-toggle button", { hasText: "Live" }).click();
  await settle(long, 300);
  return text;
};
const openLine = async () => {
  await long.locator(".block .rendered li").nth(5).click();
  await long.waitForSelector(".md-line");
  await settle(long, 150);
};
await openLine();
check(await long.locator(".large-block-note").isVisible(), "a very long block says how it edits");
check((await long.locator(".md-line").count()) === 3000, "each source line is its own box");
const caretLine = () => long.evaluate(() => [...document.querySelectorAll(".md-line")].indexOf(getSelection().anchorNode.parentElement));
check(Math.abs((await caretLine()) - 5) <= 1, "the click lands on that line", String(await caretLine()));
await long.keyboard.press("Home");
await long.keyboard.press("End");
await long.keyboard.type("Z&");
let longExpected = [...longList];
const at = await caretLine();
longExpected[at] += "Z&";
check(at >= 4 && at <= 6, "End stays on the line", String(at));
await settle(long, 100);
check((await long.locator(".md-line").nth(at).innerText()).trim() === longExpected[at], "typing goes into that line", await long.locator(".md-line").nth(at).innerText());
await long.keyboard.press("Enter");
await long.keyboard.type("split");
await settle(long, 200);
longExpected.splice(at + 1, 0, "- split");
await long.keyboard.press("Home");
await long.keyboard.press("ArrowUp");
await long.keyboard.press("End");
await long.keyboard.press("Delete");
await settle(long, 200);
longExpected.splice(at, 2, longExpected[at] + "- split");
let longText = await longSource();
check(longText === longExpected.join("\n") + "\n\nThe last paragraph\n" || longText === longExpected.join("\n") + "\n\nThe last paragraph", "typing, Enter and joining lines match the source exactly", longText.slice(0, 30));
await openLine();
await long.keyboard.press("Home");
await long.keyboard.press("Backspace");
await settle(long, 200);
check((await long.locator(".md-line").count()) === 2999, "Backspace at a line's start joins it to the one above", String(await long.locator(".md-line").count()));
await long.keyboard.press("Shift+ArrowDown");
await long.keyboard.press("Shift+ArrowDown");
await long.keyboard.type("Q");
await settle(long, 200);
check((await long.locator(".md-line").count()) === 2997, "typing over lines replaces them", String(await long.locator(".md-line").count()));
for (let i = 0; i < 3; i++) await long.keyboard.press("Control+z");
await settle(long, 300);
const undone = await long.locator(".block.active").innerText();
check(/item 2999/.test(undone), "undo leaves the block intact");
await long.locator(".block").last().click();
await settle(long, 500);
check(!(await long.locator(".md-line").count()), "it renders again on leaving");
check((await long.locator(".block .rendered li").count()) > 2900, "as a real list");
await openLine();
const edge = await long.locator(".md-line").nth((await caretLine()) + 2).boundingBox();
const host = await long.locator(".source.b-large").boundingBox();
await long.mouse.click(host.x + host.width - 20, edge.y + edge.height / 2);
await settle(long, 100);
const clickedLine = await caretLine();
await long.keyboard.type("!");
await settle(long, 100);
check(/ <b>!\s*$/.test(await long.locator(".md-line").nth(clickedLine).innerText()), "a click past a line's end types at its end", await long.locator(".md-line").nth(clickedLine).innerText());
await longContext.close();

section("the redesigned page");
const designContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const design = await open(designContext);
await settle(design, 1000);
const column = await design.locator(".block").first().boundingBox();
check(column.width <= 700, "the text column keeps a readable measure", String(column.width));
check((await design.evaluate(() => getComputedStyle(document.querySelector(".rendered p")).fontFamily)).includes("Literata"), "prose is set in the book face");
const stayStill = async (selector, label) => {
  const target = design.locator(selector).first();
  const below = () => design.locator(".block").last().evaluate((el) => el.getBoundingClientRect().top + document.querySelector(".scroll").scrollTop);
  const before = await below();
  await target.click();
  await settle(design, 200);
  const during = await below();
  await design.keyboard.press("Escape");
  await design.locator(".scroll").click({ position: { x: 10, y: 300 } });
  await settle(design, 200);
  check(Math.abs(during - before) <= 2, `opening ${label} doesn't move the page`, `${before} then ${during}`);
};
await stayStill(".block .rendered p", "a paragraph");
await stayStill(".block .rendered h2", "a heading");
await stayStill(".block .rendered ul", "a list");
const bullet = await design.locator(".block .rendered li").first().boundingBox();
await design.mouse.click(bullet.x + bullet.width - 4, bullet.y + 12);
await settle(design, 250);
const nextItem = () => design.locator(".md-list-item").nth(1).boundingBox();
const nextBefore = await nextItem();
await design.keyboard.press("Enter");
await settle(design, 250);
const newItem = await nextItem();
const movedDown = await design.locator(".md-list-item").nth(2).boundingBox();
check(newItem.height >= 20 && movedDown.y - nextBefore.y >= 20, "Enter on a bullet opens a visible new line", `${newItem.height}, ${movedDown.y - nextBefore.y}`);
const itemsWithEmpty = await design.locator(".md-list-item").count();
await design.keyboard.press("Backspace");
await settle(design, 250);
check((await design.locator(".md-list-item").count()) === itemsWithEmpty - 1, "one Backspace removes an empty bullet");
await design.keyboard.type("!");
await settle(design, 200);
check(/offline\.!/.test(await design.locator(".md-list-item").first().innerText()), "and the caret returns to the line above", await design.locator(".md-list-item").first().innerText());
await design.keyboard.press("Backspace");
await design.locator(".scroll").click({ position: { x: 10, y: 300 } });
await settle(design, 200);
await design.locator(".web-menu .web-bar-btn").click();
const designMenu = await design.locator(".web-menu .menu-item").allInnerTexts();
check(designMenu.length <= 17, "the Menu stays short", String(designMenu.length));
await design.keyboard.press("Escape");
await designContext.close();
const themeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
const themed = await open(themeContext);
await settle(themed, 800);
check((await themed.evaluate(() => getComputedStyle(document.querySelector(".app")).getPropertyValue("--accent").trim())) === "#8e422c", "the terracotta theme is the default");
check((await themed.evaluate(() => getComputedStyle(document.querySelector(".rendered p")).fontSize)) === "16px", "text is its usual size");
check(await themed.locator(".status-right").isVisible() && (await themed.locator(".status-right").evaluate((el) => getComputedStyle(el).opacity)) === "1", "the document's settings stay visible, on a phone too");
await themeContext.close();

const touchContext = await browser.newContext({ viewport: { width: 320, height: 568 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
const touch = await open(touchContext);
await settle(touch, 800);
check(!(await touch.evaluate(() => document.documentElement.scrollWidth > innerWidth)), "a small phone has no sideways scroll");
await touch.locator(".web-menu .web-bar-btn").tap();
await touch.locator(".web-sheet-row").filter({ hasText: "Format" }).first().tap();
await settle(touch, 200);
check(/Tap a paragraph first/.test(await touch.locator(".web-sheet").innerText()), "Format says why its rows are grey");
await touch.getByRole("button", { name: "Close" }).tap();
await settle(touch, 200);
await touch.locator(".topbar-toggle").first().tap();
await settle(touch, 300);
const thumbTargets = await touch.evaluate(() => [...document.querySelectorAll(".sidebar button, .side-filter")].filter((el) => { const r = el.getBoundingClientRect(); return r.height && r.height < 40; }).map((el) => el.className));
check(!thumbTargets.length, "the sidebar's controls fit a thumb", thumbTargets.join());
await touch.touchscreen.tap(310, 300);
await settle(touch, 350);
check(!(await touch.locator(".web-drawer-scrim").count()), "tapping off the sidebar closes it");
await touch.locator(".status-right button").nth(1).tap();
await settle(touch, 300);
const swatches = await touch.evaluate(() => [...document.querySelectorAll(".palette-dot")].every((el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.height >= 40; }));
check(swatches, "the theme swatches fit on screen and a thumb");
await touchContext.close();

section("the tab strip");
const stripContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const strip = await open(stripContext);
await settle(strip, 800);
for (const text of ["one", "two", "three"]) await newDoc(strip, text);
await saveAs(strip, "last-tab.md");
const activeInStrip = () => strip.evaluate(() => {
  const list = document.querySelector(".document-tab-list").getBoundingClientRect();
  const tab = document.querySelector(".document-tab.selected").getBoundingClientRect();
  return tab.left >= list.left - 1 && tab.right <= list.right + 1;
});
check(await activeInStrip(), "the active tab stays whole when saving lengthens the save state");
await strip.setViewportSize({ width: 1000, height: 800 });
await settle(strip, 300);
check(await activeInStrip(), "and when the window narrows");
for (const width of [1000, 800, 680]) {
  await strip.setViewportSize({ width, height: 800 });
  await settle(strip, 150);
  const fits = await strip.evaluate(() => {
    const bar = document.querySelector(".document-toolbar").getBoundingClientRect();
    return document.querySelector(".web-export button").getBoundingClientRect().right <= bar.right + 1;
  });
  check(fits, `Export stays on screen at ${width}px with the sidebar open`);
}
await stripContext.close();

section("two windows");
const second = await open(context);
await settle(second, 1200);
const secondTabs = await tabs(second);
check(!secondTabs.includes("real.md"), "a second window gets its own session, not the first one's", secondTabs.join());
await page.bringToFront();
await page.locator('.sidebar [data-path="/Library/Welcome.md"]').click();
await settle(page, 400);
await second.bringToFront();
await second.locator('.sidebar [data-path="/Library/Welcome.md"]').click();
await settle(second, 400);
await second.locator(".block").nth(1).click();
await second.keyboard.press("End");
await second.keyboard.type(" (from the second window)");
await second.keyboard.press("Control+s");
await settle(second, 500);
await page.bringToFront();
await settle(page, 500);
check(await page.locator(".conflict-banner, [class*=conflict]").count() > 0, "a save in another window raises the conflict banner here");
await second.close();

section("hostile markdown");
await newDoc(page, "");
await page.keyboard.press("Control+/");
await settle(page, 300);
await page.locator(".source-full").fill(`<img src=x onerror="window.__pwned=1">\n\n<script>window.__pwned=2</script>\n\n[click](javascript:window.__pwned=3)\n\n<svg onload="window.__pwned=4"></svg>\n\n<iframe srcdoc="<script>parent.__pwned=5</script>"></iframe>\n\n![x](../../../etc/passwd)\n`);
await page.keyboard.press("Control+/");
await settle(page, 800);
await page.locator(".block a").first().click({ force: true }).catch(() => {});
await settle(page, 300);
check(await page.evaluate(() => window.__pwned === undefined), "no markup runs");
check(page.url().startsWith(URL_), "and nothing navigated away");

// The sanitizer alone, without the CSP behind it: each must hold by itself.
const bare = await browser.newContext({ viewport: { width: 1280, height: 860 }, serviceWorkers: "block" });
await bare.route(URL_, async (route) => {
  const response = await route.fetch();
  await route.fulfill({ response, body: (await response.text()).replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "") });
});
const exposed = await open(bare);
await settle(exposed, 800);
await exposed.locator(".document-tab-new").click();
await exposed.keyboard.press("Control+/");
await settle(exposed, 300);
await exposed.locator(".source-full").fill(`<img src=x onerror="window.__pwned=1">\n\n<svg onload="window.__pwned=4"></svg>\n\n<a href="#" onclick="window.__pwned=6">x</a>\n`);
await exposed.keyboard.press("Control+/");
await settle(exposed, 900);
await exposed.locator(".block a").first().click({ force: true }).catch(() => {});
await settle(exposed, 300);
check(await exposed.evaluate(() => window.__pwned === undefined), "the sanitizer stops it even with the CSP removed");
check(await exposed.locator(".block [onerror], .block [onload], .block [onclick]").count() === 0, "no event handler reaches the page");
await bare.close();

section("Pandoc in WebAssembly");
await newDoc(page, "");
await page.keyboard.press("Control+/");
await settle(page, 300);
await page.locator(".source-full").fill(`---\ntitle: x\n---\n\n# Report\n\nSome **bold** text with a [link](https://example.com).\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![pic](/Library/assets/${"PLACEHOLDER"})\n`);
const assetName = await page.evaluate(async () => new Promise((resolve) => {
  const req = indexedDB.open("sarala");
  req.onsuccess = () => {
    const get = req.result.transaction("files").objectStore("files").getAllKeys();
    get.onsuccess = () => resolve(get.result.find((k) => k.endsWith(".png")));
  };
}));
const value = await page.locator(".source-full").inputValue();
await page.locator(".source-full").fill(value.replace("/Library/assets/PLACEHOLDER", assetName));
await page.keyboard.press("Control+/");
await settle(page, 400);
const started = Date.now();
await palette(page, "Export: Word");
await page.locator(".pandoc-dl").waitFor({ timeout: 5000 });
if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-pandoc.png` });
const docx = await downloadOf(page, async () => {
  await page.locator(".pandoc-dl").getByRole("button", { name: "Download" }).click();
});
console.log(`  (download + first conversion: ${((Date.now() - started) / 1000).toFixed(1)}s)`);
const entries = unzipSync(new Uint8Array(docx.bytes));
const documentXml = strFromU8(entries["word/document.xml"] ?? new Uint8Array());
check(documentXml.includes("Report") && documentXml.includes("<w:tbl>"), "docx holds the heading and a real table");
check(!documentXml.includes("title: x"), "front matter stays out of the body");
check(Object.keys(entries).some((k) => k.startsWith("word/media/")), "the workspace image is embedded", Object.keys(entries).join());
for (const [label, signature] of [["OpenOffice", "PK"], ["Epub", "PK"], ["RTF", "{\\rtf"], ["LaTeX", "\\documentclass"], ["reStructuredText", "Report"], ["Media Wiki", "Report"], ["Textile", "Report"], ["OPML", "<outline"]]) {
  const out = await downloadOf(page, () => palette(page, `Export: ${label}`)).catch((e) => ({ name: "", bytes: Buffer.from(String(e)) }));
  check(out.bytes.subarray(0, 400).toString("latin1").includes(signature), `${label} export`, `${out.name}: ${out.bytes.subarray(0, 80).toString("latin1")}`);
}
const [importChooser] = await Promise.all([page.waitForEvent("filechooser"), palette(page, "Import…")]);
await importChooser.setFiles({ name: "report.docx", mimeType: "application/octet-stream", buffer: docx.bytes });
await page.waitForFunction(() => document.querySelectorAll(".block img").length >= 1 && /Report/.test(document.body.innerText), null, { timeout: 30000 }).catch(() => {});
await settle(page, 900);
const imported = (await page.locator(".block").allInnerTexts()).join(" ");
check(/Report/.test(imported) && /bold/.test(imported), "a docx imports back to Markdown", imported.slice(0, 80));
const importedImages = await shown();
check(importedImages.some((i) => i.w === 10), "with its embedded image", JSON.stringify(importedImages));

section("backup and restore");
const zipFile = await downloadOf(page, () => palette(page, "Back Up Library"));
const zipped = unzipSync(new Uint8Array(zipFile.bytes));
check(/^sarala-library-\d{4}-\d\d-\d\d\.zip$/.test(zipFile.name), "the backup is a dated zip", zipFile.name);
check(!!zipped["Welcome.md"] && Object.keys(zipped).some((k) => k.endsWith(".png")), "with documents and images, as plain files", Object.keys(zipped).join());

const fresh = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true });
const clean = await open(fresh);
await settle(clean, 800);
const [restoreChooser] = await Promise.all([clean.waitForEvent("filechooser"), palette(clean, "Restore Library")]);
await restoreChooser.setFiles({ name: zipFile.name, mimeType: "application/zip", buffer: zipFile.bytes });
await settle(clean, 1500);
check((await tree(clean)).some((p) => p.endsWith("pics.md")), "it restores into another browser profile", (await tree(clean)).join());
await fresh.close();

section("offline");
await page.bringToFront();
await page.reload();
await page.waitForSelector(".block");
await page.waitForFunction(async () => (await navigator.serviceWorker.ready).active?.state === "activated", null, { timeout: 30000 });
await page.reload();
await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
await settle(page, 2500);
await context.setOffline(true);
await page.reload();
await page.waitForSelector(".block", { timeout: 15000 });
await settle(page, 800);
check((await tree(page)).includes("/Library/Welcome.md"), "the app and library load with no network");
await newDoc(page, "Written offline");
await saveAs(page, "offline.md");
check((await tree(page)).includes("/Library/offline.md"), "saving works offline");
await context.setOffline(false);

section("updates");
await palette(page, "Check for Updates");
await settle(page, 1200);
check((page.dialogs ?? []).some((d) => /up to date/i.test(d)), "Check for Updates answers", (page.dialogs ?? []).join(" | "));

section("no problems along the way");
// Parsing hostile markup in an inert document (a <template>, DOMPurify's
// DOMParser) makes Chrome report the attributes it sees. Nothing runs, as the
// sanitizer check above proves, and the hostile tab comes back on every reload.
const real = page.problems.filter((p) => !/inline event handler/.test(p));
check(real.length === 0, "no page errors or other CSP violations", real.join("\n"));

await browser.close();
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
