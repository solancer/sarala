/**
 * Live-app check: pressing a zoomed D2 diagram's horizontal scrollbar scrolls
 * it, and does not open the block for editing (which re-renders the diagram
 * and throws the scroll position away).
 *
 *   node tests/e2e-d2-scroll.mjs   (starts its own server on :1474)
 */
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";

const PORT = 1474;
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

let failures = 0;
const check = (cond, label) => { console.log(`${cond ? "PASS" : "FAIL"}: ${label}`); if (!cond) failures++; };

const md = "```d2 zoom=200\ndirection: right\na -> b -> c -> d -> e -> f -> g -> h\n```";

for (const engine of [chromium, webkit]) {
  const name = engine.name();
  const browser = await engine.launch();
  const page = await browser.newPage({ viewport: { width: 1150, height: 760 } });
  page.on("pageerror", (e) => console.log(`[${name} pageerror]`, e.message));
  await page.goto(`http://localhost:${PORT}`);
  await page.waitForSelector(".block");

  await page.locator(".block").first().click();
  await page.waitForSelector(".block.active .source");
  await page.evaluate((text) => {
    const el = document.querySelector(".block.active .source");
    const dt = new DataTransfer();
    dt.setData("text/plain", text);
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
  }, md);
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  const diagram = page.locator(".block:not(.active) .d2-block");
  await diagram.locator("svg").first().waitFor({ timeout: 20000 });

  const box = await diagram.evaluate((el) => {
    el.scrollLeft = 200;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.bottom - 4, bar: el.offsetHeight - el.clientHeight, overflow: el.scrollWidth > el.clientWidth };
  });
  check(box.overflow, `${name}: zoomed diagram overflows its column`);
  // A press-and-release on the scrollbar track: the target is the scroll box itself.
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(400);
  const target = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className?.baseVal ?? document.elementFromPoint(x, y)?.className, [box.x, box.y]);
  check(await page.locator(".block.active").count() === 0, `${name}: pressing the scrollbar doesn't open the block (scrollbar ${box.bar}px, hit ${target})`);
  check(await page.locator(".d2-block").first().evaluate((el) => el.scrollLeft) > 0, `${name}: the diagram keeps its scroll position`);

  await diagram.locator("svg").first().click();
  check(await page.locator(".block.active").count() === 1, `${name}: clicking the diagram itself still opens the block`);

  await browser.close();
}

kill();
if (failures) { console.log(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nall d2 scroll checks passed");
