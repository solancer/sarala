/**
 * Live-app check of the link hover helper.
 *
 *   node tests/e2e-links.mjs   (starts its own server on :1457)
 *
 * The unit tests (tests/format.test.mjs) cover finding links in the source.
 * This covers what only a live DOM can: that hovering a *rendered* anchor
 * resolves back to the right occurrence, and that the actions rewrite the
 * block's markdown correctly.
 */
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";

const PORT = 1457;
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
const page = await browser.newPage({ viewport: { width: 1150, height: 760 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

const source = async () => {
  await page.locator(".view-toggle button", { hasText: "Source" }).click();
  await page.waitForSelector(".source-full");
  const t = await page.locator(".source-full").inputValue();
  await page.locator(".view-toggle button", { hasText: "Live" }).click();
  await page.waitForSelector(".block");
  await page.waitForTimeout(250);
  return t;
};
/** Hover a link and wait past the hover-intent delay. */
const hoverLink = async (nth = 0) => {
  await page.locator(".block .rendered a").nth(nth).dispatchEvent("mouseover");
  await page.waitForTimeout(600);
};

// Seed: a markdown link, a repeated href, and a bare URL.
await page.locator(".block").first().click();
await page.waitForSelector(".block.active .source");
await page.evaluate((md) => {
  const el = document.querySelector(".block.active .source");
  const dt = new DataTransfer();
  dt.setData("text/plain", md);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, "See [Shiki](https://shiki.style) and [again](https://shiki.style), plus https://bare.example.com here.");
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

const tools = page.locator(".link-tools");
// Park the pointer clear of the text: after the paste it can be left resting
// over a link, in which case the helper is correctly already showing.
await page.mouse.move(20, 700);
await page.waitForTimeout(400);
check(!(await tools.isVisible().catch(() => false)), "no helper until a link is hovered");

await hoverLink(0);
check(await tools.isVisible(), "hovering a link shows the helper");
check(
  (await page.locator(".lht-url").textContent()) === "https://shiki.style",
  "it shows where the link points",
);

// Repeated hrefs must resolve to the right occurrence, which is why this
// matches by href + index rather than by anchor ordinal.
await hoverLink(1);
await page.locator(".lht-btn[title='Edit link']").click();
await page.waitForTimeout(250);
await page.locator(".lht-input").fill("https://second.example");
await page.locator(".lht-ok").click();
await page.waitForTimeout(500);
{
  const md = await source();
  check(
    md.includes("[Shiki](https://shiki.style)") && md.includes("[again](https://second.example)"),
    `editing the second occurrence left the first alone (${JSON.stringify(md.slice(0, 80))})`,
  );
}

// Remove link unwraps to the label, keeping the visible text.
await hoverLink(0);
await page.locator(".lht-btn[title^='Remove link']").click();
await page.waitForTimeout(500);
{
  const md = await source();
  check(!md.includes("[Shiki]("), "remove-link unwrapped the markdown");
  check(md.includes("See Shiki and"), `and kept the label as plain text (${JSON.stringify(md.slice(0, 40))})`);
}

// A bare autolinked URL is its own label, so it is told apart from a wrapped one.
await hoverLink(1);
check(
  (await page.locator(".lht-url").textContent()) === "https://bare.example.com",
  "a bare URL is picked up too",
);
check(
  (await page.getAttribute(".lht-btn[title^='Remove link']", "title")).includes("keeps the URL text"),
  "and its remove action explains it differs",
);

// --- hover intent: a brush past a link must not flash the helper ---
await page.evaluate(() => {
  document.querySelector(".block .rendered")
    ?.dispatchEvent(new MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
});
await page.waitForTimeout(200);
check(!(await tools.isVisible().catch(() => false)), "leaving dismisses immediately, with no lingering popover");
await page.locator(".block .rendered a").first().dispatchEvent("mouseover");
await page.waitForTimeout(120);
check(
  !(await tools.isVisible().catch(() => false)),
  "a brief brush past a link does not open it",
);
await page.waitForTimeout(500);
check(await tools.isVisible(), "resting on it does");

// The card is padded off its wrapper, so moving from link to card never
// crosses dead space — what lets dismissal be immediate.
{
  const pad = await page.locator(".link-tools").evaluate((el) => getComputedStyle(el).paddingTop);
  check(pad === "6px", `the wrapper bridges the gap to the card (${pad})`);
  const wrapBg = await page.locator(".link-tools").evaluate((el) => getComputedStyle(el).backgroundColor);
  check(wrapBg === "rgba(0, 0, 0, 0)", "and the bridge itself is invisible");
}

// --- following a relative link to a sibling document ---
// Regression: this used to reach the OS opener as a schemeless relative path
// and silently do nothing. The browser build has no filesystem, so assert the
// routing decision rather than the open itself.
{
  const routed = await page.evaluate(async () => {
    const m = await import("/src/links.ts");
    const dir = "/home/me/notes";
    return {
      doc: m.linkDestination("RELEASING.md", dir),
      ext: m.linkDestination("https://example.com", dir),
      anchor: m.linkDestination("#install", dir),
      png: m.linkDestination("shot.png", dir),
    };
  });
  check(routed.doc.kind === "document", "a relative .md routes to the editor, not the OS");
  check(
    routed.doc.path === "/home/me/notes/RELEASING.md",
    `and resolves against the document's folder (${routed.doc.path})`,
  );
  check(routed.ext.kind === "external", "an http url still goes to the OS");
  check(routed.anchor.kind === "anchor", "a fragment scrolls this document");
  check(routed.png.kind === "file", "a local non-document goes to the desktop");
}

// The helper offers the four actions.
const titles = await page.locator(".lht-btn").evaluateAll((els) => els.map((e) => e.title));
check(titles.length === 4, `four actions (${JSON.stringify(titles)})`);

// Clicking a link must never navigate the app's own webview. WebKit (the
// macOS app's engine) runs a Cmd+click's default action, which loaded the page
// into the app window. Checked there with window.open stubbed, as in the app,
// where links open through the OS instead.
{
  const wk = await webkit.launch();
  const wpage = await wk.newPage({ viewport: { width: 1150, height: 760 } });
  await wpage.addInitScript(() => {
    window.__opened = [];
    window.open = (u) => { window.__opened.push(String(u)); return null; };
  });
  const home = `http://localhost:${PORT}/`;
  await wpage.goto(home);
  await wpage.waitForSelector(".block");
  await wpage.locator(".block").first().click();
  await wpage.keyboard.type("See [the site](https://example.com) here.");
  await wpage.keyboard.press("Enter");
  await wpage.keyboard.type("End.");
  await wpage.waitForTimeout(300);
  const link = () => wpage.locator('.editor .page > .block a[href="https://example.com"]').first();
  await link().click({ modifiers: ["Meta"] });
  await wpage.waitForTimeout(400);
  check(wpage.url() === home, `Cmd+click leaves the app in place (${wpage.url()})`);
  check((await wpage.evaluate(() => window.__opened)).includes("https://example.com"), "and opens the link outside the app");
  await link().click({ button: "middle" });
  await wpage.waitForTimeout(300);
  check(wpage.url() === home, "a middle-click doesn't navigate the app either");
  await link().click();
  await wpage.waitForTimeout(300);
  check(wpage.url() === home, "a plain click edits instead of navigating");
  await wk.close();
}

await browser.close();
kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
