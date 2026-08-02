/**
 * Live-app check of the Image Properties panel: real Vite dev server, real
 * Chromium, real markdown-to-html promotion in the document source.
 *
 *   node tests/e2e-imageprops.mjs   (starts its own server on :1427)
 *
 * The unit tests (tests/format.test.mjs) cover attribute parsing and tag
 * building. This covers what only a live DOM can: that the panel opens from
 * the hover toolbar, that committing a field rewrites the block's source, and
 * that the rendered <img> actually carries the attribute afterwards (i.e. it
 * survived DOMPurify).
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1427;
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
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".block");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

const source = () =>
  page.evaluate(() =>
    [...document.querySelectorAll(".block")]
      .map((b) => b.querySelector(".source")?.textContent ?? b.querySelector(".rendered")?.dataset.md ?? "")
      .join(""),
  );
/**
 * The document's markdown, read via the Source view. Activating the block
 * would also expose it, but the properties panel overlays the block and the
 * image fills it, so there is nowhere reliable to click.
 */
const blockSource = async () => {
  await page.locator(".view-toggle button", { hasText: "Source" }).click();
  await page.waitForSelector(".source-full");
  const t = await page.locator(".source-full").inputValue();
  await page.locator(".view-toggle button", { hasText: "Live" }).click();
  await page.waitForSelector(".block");
  await page.waitForTimeout(250);
  return t;
};


/**
 * Open the properties panel for the first image.
 *
 * Dispatches `mouseover` rather than moving a real cursor: the hover toolbar is
 * an overlay pinned near the image's top-left, so once the image is resized a
 * real hover lands on the toolbar (or misses a small image entirely) and
 * Playwright's hit-testing refuses. The handler only reads `event.target`, so a
 * dispatched event exercises the same path without the geometry fight.
 */
async function hoverImage() {
  await page.locator(".block .rendered img").first().dispatchEvent("mouseover");
  await page.waitForTimeout(300);
}
async function openPanel() {
  // The toolbar is not rendered while the panel is up, so dismiss first.
  if (await page.locator(".img-props").isVisible().catch(() => false)) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(250);
  }
  await hoverImage();
  await page.locator(".iht-btn[title='Image properties…']").click();
  await page.waitForTimeout(300);
}

// A 400x300 PNG: offline and synchronous, but big enough that the hover
// toolbar (an overlay near the top-left) does not cover the whole image.
const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAZAAAAEsCAIAAABi1XKVAAAC90lEQVR42u3UQQ0AAAjEsNOJCJQgGh2QJlWwx1I9ACdEAsCwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCDEsFwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIMSwXAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsAAMCzAsAMMCDAvAsAAMCzAsAMMCMCzAsAAMC8CwAMMCMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAAw5IAMCwAwwIMC8CwAAwLMCwAwwIwLMCwAAwLwLAAwwIwLADDAgwLwLAADAswLADDAjAswLAADAvAsADDAjAsAMMCDAvAsADDUgEwLADDAgwLwLAADAswLADDAjAswLAADAvAsIDPFnass3NjHO1dAAAAAElFTkSuQmCC";

await page.locator(".block").first().click();
await page.waitForSelector(".block.active .source");
await page.evaluate((md) => {
  const el = document.querySelector(".block.active .source");
  const dt = new DataTransfer();
  dt.setData("text/plain", md);
  el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
}, `![A picture](${PIXEL})`);
await page.waitForTimeout(300);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

check((await blockSource()).startsWith("![A picture]("), "sanity: block holds a markdown image");

// --- open the panel from the hover toolbar ---
await hoverImage();
check(await page.locator(".img-tools").isVisible(), "hovering the image shows the toolbar");
await page.locator(".iht-btn[title='Image properties…']").click();
await page.waitForTimeout(300);
const panel = page.locator(".img-props");
check(await panel.isVisible(), "the properties button opens the panel");
check(
  (await page.locator(".ip-field .ip-label").allTextContents()).join(",") === "Src,Alt",
  `Source holds Src and Alt (${(await page.locator(".ip-field .ip-label").allTextContents()).join(",")})`,
);
check(await page.locator(".ip-range").isVisible(), "size is a slider, not hidden behind Advanced");
// The panel floats over the image it edits, so it identifies its own subject.
check(await page.locator(".ip-thumb img").count() === 1, "the panel shows a thumbnail of the image");
check(
  (await page.locator(".ip-meta").textContent()).includes("×"),
  "and the image's intrinsic size",
);
check(
  (await page.locator(".ip-section").allTextContents()).join(",") === "Source,Size",
  "the panel is split into labelled sections",
);
// Width and Height are one idea, so they are a matched pair — width used to be
// slider-only with no way to type a figure, and height a lone stepper.
check(await page.locator(".ip-dim .ip-input").count() === 2, "width and height are a matched pair");
check(await page.locator(".ip-link").count() === 1, "an aspect-ratio lock sits between them");
check(
  await page.locator(".ip-input").nth(1).inputValue() === "A picture",
  "Alt is populated from the markdown image",
);

// --- Advanced discloses the rest ---
await page.locator(".ip-adv-toggle").click();
await page.waitForTimeout(250);
const advLabels = await page.locator(".ip-adv .ip-label").allTextContents();
check(advLabels.length === 8, `Advanced holds the remaining eight attributes (${advLabels.length})`);
check(
  await page.locator(".ip-pair").count() === 2,
  "the short enums pack two-up instead of four stacked rows",
);
check(
  !advLabels.includes("Width") && !advLabels.includes("Height"),
  "size moved out of Advanced into its own block",
);
check(
  JSON.stringify(await page.locator(".ip-group").allTextContents())
    === '["Responsive","Performance","Security","Metadata"]',
  "Advanced fields are grouped by purpose",
);
check(await page.locator(".ip-note").isVisible(), "a markdown image warns that editing promotes to <img>");

// --- setting Width promotes the source to an <img> tag ---
await page.locator(".ip-range").evaluate((el) => {
  el.value = "820";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(400);
const promoted = await blockSource();
check(promoted.startsWith("<img "), `markdown was promoted to a tag (${JSON.stringify(promoted)})`);
check(promoted.includes('width="820"'), "width landed in the source");
check(promoted.includes('alt="A picture"'), "alt survived the promotion");

// --- the attribute survives sanitization and reaches the DOM ---
check(
  await page.locator(".block .rendered img").first().getAttribute("width") === "820",
  "the rendered <img> carries width (survived DOMPurify)",
);

// --- a second edit must not discard the first ---
await openPanel();
await page.locator(".ip-adv-toggle").click();
await page.waitForTimeout(200);
const loading = page.locator(".ip-adv select").first();
await loading.selectOption("eager");
await page.waitForTimeout(400);
const both = await blockSource();
check(both.includes('width="820"'), "the earlier width survived a later edit");
check(both.includes('loading="eager"'), "loading was added");

// fetchpriority is the attribute DOMPurify drops by default — verify the
// allowlist addition actually took.
await openPanel();
await page.locator(".ip-adv-toggle").click();
await page.waitForTimeout(200);
await page.locator(".ip-adv select").nth(2).selectOption("high");
await page.waitForTimeout(400);
check((await blockSource()).includes('fetchpriority="high"'), "fetchpriority reaches the source");
check(
  await page.locator(".block .rendered img").first().getAttribute("fetchpriority") === "high",
  "fetchpriority survives DOMPurify (allowlist addition works)",
);

// --- the Advanced counter reflects what is set ---
await openPanel();
// width + height (the lock sets both) + loading + fetchpriority.
check(
  await page.locator(".ip-adv-count").textContent() === "4",
  `the Advanced badge counts set fields (${await page.locator(".ip-adv-count").textContent()})`,
);

// --- aspect-ratio lock ---
// Left until here deliberately: filling a dimension promotes the image to an
// <img> tag, which retires the "this will promote" note checked above.
await openPanel();
{
  await page.locator(".ip-dim .ip-input").first().fill("200");
  await page.waitForTimeout(500);
  const h = await page.locator(".ip-dim .ip-input").nth(1).inputValue();
  check(h === "150", `locking the ratio carries height along (400x300 → 200/${h})`);
  await page.locator(".ip-link").click();
  await page.waitForTimeout(200);
  await page.locator(".ip-dim .ip-input").first().fill("240");
  await page.waitForTimeout(600);
  check(
    (await page.locator(".ip-dim .ip-input").nth(1).inputValue()) === "150",
    "unlocking leaves the other dimension alone",
  );
  await page.locator(".ip-link").click();
  await page.waitForTimeout(200);
}

// --- live edits: no Enter required ---
await openPanel();
{
  // Type into Alt without pressing Enter or blurring; the block must rewrite.
  const alt = page.locator(".ip-field .ip-input").nth(1);
  await alt.fill("Live edited alt");
  await page.waitForTimeout(500);
  check(
    (await blockSource()).includes('alt="Live edited alt"'),
    "typing commits live, with no Enter and no blur",
  );
}

// --- the size slider ---
await openPanel();
check(await page.locator(".ip-range").isVisible(), "width has a slider");
await page.locator(".ip-range").evaluate((el) => {
  el.value = "300";
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
await page.waitForTimeout(500);
check((await blockSource()).includes('width="300"'), "dragging the slider applies width live");
await openPanel();
// The separate px readout is gone: the W field *is* the readout now, so the
// slider and the typed value are one number rather than two views of it.
check(
  (await page.locator(".ip-dim .ip-input").first().inputValue()) === "300",
  `the width field tracks the slider (${await page.locator(".ip-dim .ip-input").first().inputValue()})`,
);
await page.locator(".ip-size-reset").click();
await page.waitForTimeout(500);
check(!(await blockSource()).includes("width="), "Auto clears the width");

// --- advanced grouping ---
await openPanel();
await page.locator(".ip-adv-toggle").click();
await page.waitForTimeout(300);
const groups = await page.locator(".ip-group").allTextContents();
check(
  JSON.stringify(groups) === '["Responsive","Performance","Security","Metadata"]',
  `advanced fields are grouped by purpose (${JSON.stringify(groups)})`,
);

// --- dismissal ---
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
check(!(await page.locator(".img-props").isVisible().catch(() => false)), "Escape closes the panel");

await openPanel();
check(await page.locator(".img-props").isVisible(), "panel reopens");
await page.mouse.click(1100, 700);
await page.waitForTimeout(400);
check(
  !(await page.locator(".img-props").isVisible().catch(() => false)),
  "clicking outside closes the panel",
);

await browser.close();
kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
