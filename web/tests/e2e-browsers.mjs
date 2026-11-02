/**
 * The other engines. Chrome gets the deep suite (e2e-web.mjs); this covers what
 * differs without the File System Access API, where `contenteditable`, file
 * inputs and storage take other code paths.
 *
 *   npx playwright install firefox webkit
 *   node tests/e2e-browsers.mjs
 */
import { spawn } from "node:child_process";
import { firefox, webkit } from "playwright";

const PORT = 1427;
const server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], {
  cwd: new URL("..", import.meta.url).pathname, stdio: "pipe",
});
process.on("exit", () => server.kill());
await new Promise((r) => server.stdout.on("data", (d) => String(d).includes("Local") && r()));

let failures = 0;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mNk+M9Qz0AEYBxVSF+FABJADveWkH6oAAAAAElFTkSuQmCC", "base64");
const SJIS = Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea, 0x82, 0xcc, 0x83, 0x65, 0x83, 0x4c, 0x83, 0x58, 0x83, 0x67, 0x0a, 0x82, 0xb1, 0x82, 0xea, 0x82, 0xcd, 0x53, 0x68, 0x69, 0x66, 0x74, 0x5f, 0x4a, 0x49, 0x53, 0x82, 0xc5, 0x82, 0xb7, 0x0a]);

for (const [name, engine] of [["Firefox", firefox], ["WebKit", webkit]]) {
  console.log(`\n== ${name}`);
  const check = (ok, label, detail = "") => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${label}${!ok && detail ? ` -- ${detail}` : ""}`);
    if (!ok) failures++;
  };
  const browser = await engine.launch().catch((e) => { console.log("skipped:", e.message.split("\n")[0]); return null; });
  if (!browser) continue;
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (d) => { errors.push(`dialog: ${d.message()}`); void d.accept(); });
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".block", { timeout: 20000 });
  await page.waitForTimeout(2000);
  check((await page.title()).startsWith("Welcome.md"), "the welcome document opens");
  check(await page.locator(".block .katex").count() > 0, "math renders");
  check(await page.locator(".block pre.shiki, .block .shiki").count() > 0, "code is highlighted");
  check(await page.locator(".block svg").count() > 0, "a diagram renders");

  await page.locator(".document-tab-new").click();
  await page.waitForTimeout(300);
  await page.keyboard.type("Typed in the editor");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Second block with **bold**");
  await page.waitForTimeout(300);
  await page.locator(".scroll").click({ position: { x: 5, y: 5 }, force: true });
  await page.waitForTimeout(300);
  check((await page.locator(".block strong").count()) === 1, "typing and block rendering work");

  await page.locator(".block").first().click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+s");
  await page.locator("#web-path-name").fill("note.md");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  check(await page.locator('.sidebar [data-path="/Library/note.md"]').count() === 1, "saving reaches the library");
  await page.keyboard.type(" and on");
  await page.waitForTimeout(800);
  await page.reload();
  await page.waitForSelector(".block");
  await page.waitForTimeout(1200);
  const body = (await page.locator(".block").allInnerTexts()).join(" ");
  check(/Typed in the editor|and on/.test(body), "a reload keeps the open document", body.slice(0, 80));
  check(/and on/.test(body), "and its unsaved edit", body.slice(0, 80));

  const command = async (text) => {
    await page.keyboard.press("Control+k");
    await page.locator('[aria-modal="true"] input').first().fill(text);
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
  };
  const [opener] = await Promise.all([page.waitForEvent("filechooser"), command("Open…")]);
  await opener.setFiles({ name: "legacy.md", mimeType: "text/markdown", buffer: SJIS });
  await page.waitForTimeout(900);
  check((await page.locator(".block").allInnerTexts()).join(" ").includes("日本語"), "a file input opens a copy, and the Rust decoder runs");

  await page.locator(".document-tab-new").click();
  await page.waitForTimeout(300);
  await page.keyboard.type("Pic ");
  const [picker] = await Promise.all([page.waitForEvent("filechooser"), command("Insert Image")]);
  await picker.setFiles({ name: "pic.png", mimeType: "image/png", buffer: PNG });
  await page.waitForTimeout(900);
  await page.locator(".scroll").click({ position: { x: 5, y: 5 }, force: true });
  await page.waitForTimeout(900);
  const sizes = await page.locator(".block img").evaluateAll((all) => all.map((i) => i.naturalWidth));
  check(sizes.includes(10), "an inserted image is stored in IndexedDB and renders", JSON.stringify(sizes));

  await command("Export: Word");
  await page.locator(".pandoc-dl").getByRole("button", { name: "Download" }).click();
  const docx = await page.waitForEvent("download", { timeout: 60000 }).catch(() => null);
  check(docx?.suggestedFilename().endsWith(".docx"), "Pandoc WebAssembly exports docx");

  check(errors.length === 0, "no page errors or alerts", errors.join(" | ").slice(0, 400));
  await browser.close();
}
console.log(failures ? `\n${failures} failed` : "\nall passed");
process.exit(failures ? 1 : 0);
