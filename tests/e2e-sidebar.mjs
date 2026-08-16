/**
 * Live-app checks for the sidebar rework: real Vite dev server, real Chromium.
 *
 *   node tests/e2e-sidebar.mjs   (starts its own server on :1430)
 *
 * The browser build has no filesystem, so the tree is injected by stubbing the
 * fileTree signal through a seeded window hook — these checks are about the
 * sidebar's own behaviour (flattening, filtering, expansion persistence,
 * windowing, ARIA), not about Rust directory listing.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1430;
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

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};

// Seed localStorage settings before the app boots so initSettings picks them up.
await page.addInitScript(() => {
  localStorage.setItem("sarala.settings", JSON.stringify({
    recentFiles: ["/v/README.md", "/v/aws/README.md", "/v/notes/todo.md"],
    openFolders: [],
  }));
});
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".sidebar");

/** Install a synthetic file tree via the app's own store setter. */
async function seedTree(tree) {
  await page.evaluate(async (t) => {
    const mod = await import("/src/store.ts");
    mod.setFileTree(t);
    mod.setFolderName("vault");
    mod.setFolderPath("/v");
  }, tree);
  await page.waitForTimeout(300);
}

const dir = (name, path, children) => ({ name, path, is_dir: true, children });
const file = (name, path) => ({ name, path, is_dir: false, children: null });

await seedTree([
  dir("aws", "/v/aws", [
    dir("notes", "/v/aws/notes", [file("deep.md", "/v/aws/notes/deep.md")]),
    file("README.md", "/v/aws/README.md"),
  ]),
  dir("Docs", "/v/Docs", [file("atlas.md", "/v/Docs/atlas.md")]),
  file("README.md", "/v/README.md"),
]);

const rowNames = () => page.locator(".side-tree .tree-nm").allTextContents();

// --- workspace header ---
// The old header was an accent "S" badge restating the first letter of the word
// beside it, plus a bare "+" with no sibling to disambiguate it.
check(await page.locator(".side-ws-badge").count() === 0, "the redundant initial badge is gone");
check(await page.locator(".side-ws-glyph").count() === 1, "a folder glyph labels what the name is");
check(
  await page.locator(".side-ws-name").textContent() === "vault",
  "the header names the open folder",
);
{
  const titles = await page
    .locator(".side-ws-head .side-icon-btn")
    .evaluateAll((els) => els.map((e) => e.title));
  check(titles.length === 2, `the header offers two labelled actions (${titles.length})`);
  check(
    titles.some((t) => /folder/i.test(t)) && titles.some((t) => /new file/i.test(t)),
    `both actions say what they do (${JSON.stringify(titles)})`,
  );
}
// The name must not fall back to the app name, which read as branding and hid
// the fact that nothing is open.
await page.evaluate(async () => {
  const m = await import("/src/store.ts");
  m.setFolderName(null);
});
await page.waitForTimeout(300);
check(
  await page.locator(".side-ws-name").textContent() === "No folder open",
  "with no folder open the header names that state, not the app",
);
check(
  await page.locator(".side-ws-name").evaluate((el) => el.classList.contains("empty")),
  "the empty state is styled as a state, not a title",
);
await page.evaluate(async () => {
  const m = await import("/src/store.ts");
  m.setFolderName("vault");
});
await page.waitForTimeout(300);

// --- #3 default collapsed ---
check(
  JSON.stringify(await rowNames()) === '["aws","Docs","README.md"]',
  `folders start collapsed (${JSON.stringify(await rowNames())})`,
);

// --- #1 expansion persists across a tree refresh ---
await page.locator(".side-tree .tree-item", { hasText: "aws" }).first().click();
await page.waitForTimeout(250);
check((await rowNames()).includes("notes"), "clicking a folder expands it");
// refreshTree() replaces every node object — the old per-row signals died here.
await seedTree([
  dir("aws", "/v/aws", [
    dir("notes", "/v/aws/notes", [file("deep.md", "/v/aws/notes/deep.md")]),
    file("README.md", "/v/aws/README.md"),
  ]),
  dir("Docs", "/v/Docs", [file("atlas.md", "/v/Docs/atlas.md")]),
  file("README.md", "/v/README.md"),
]);
check(
  (await rowNames()).includes("notes"),
  "expansion survives a full tree refresh (the Save As / Rename / Delete bug)",
);
check(
  JSON.parse(await page.evaluate(() => localStorage.getItem("sarala.settings"))).openFolders
    .includes("/v/aws"),
  "expansion is written to settings for the next launch",
);

// --- #12 ARIA on rows ---
const aws = page.locator('.side-tree [data-path="/v/aws"]');
check(await aws.getAttribute("aria-level") === "1", "top-level row reports aria-level 1");
check(await aws.getAttribute("aria-expanded") === "true", "expanded folder reports aria-expanded");
check(await aws.getAttribute("aria-setsize") === "3", "row reports aria-setsize");
// `notes` is a level down and still collapsed, so open it to reach deep.md.
await page.locator('.side-tree [data-path="/v/aws/notes"]').click();
await page.waitForTimeout(250);
const deep = page.locator('.side-tree [data-path="/v/aws/notes/deep.md"]');
check(await deep.getAttribute("aria-level") === "3", "nested row reports its depth");

// --- #5 filename filter ---
await page.locator(".side-filter-input").fill("atlas");
await page.waitForTimeout(300);
const filtered = await rowNames();
check(filtered.includes("atlas.md"), "filter finds a nested file");
check(filtered.includes("Docs"), "filter keeps the ancestor folder so the match is reachable");
check(!filtered.includes("README.md"), "filter excludes non-matching files");
await page.locator(".side-filter-input").fill("zzzznope");
await page.waitForTimeout(250);
check(
  (await page.locator(".sidebar-empty").textContent()).includes("No files match"),
  "filter shows an empty state",
);
await page.locator(".side-filter-input").fill("");
await page.waitForTimeout(250);

// --- #4 reveal the active file ---
await page.evaluate(async () => {
  const mod = await import("/src/store.ts");
  mod.setFilePath("/v/aws/notes/deep.md");
});
await page.waitForTimeout(500);
check(
  (await rowNames()).includes("deep.md"),
  "opening a nested file expands its ancestors in the tree",
);
check(
  await page.locator('.side-tree [data-path="/v/aws/notes/deep.md"]').evaluate(
    (el) => el.classList.contains("current"),
  ),
  "the revealed row is marked current",
);

// --- #2 Recent disambiguation ---
const recentTitles = await page.locator(".side-recent .tree-item").evaluateAll(
  (els) => els.map((e) => e.getAttribute("title")),
);
check(recentTitles.includes("/v/aws/README.md"), "Recent rows carry the full path as a tooltip");
const parents = await page.locator(".side-recent .tree-parent").allTextContents();
check(
  parents.includes("v") && parents.includes("aws"),
  `duplicate basenames show their folder (${JSON.stringify(parents)})`,
);

// --- #6 collapsible Recent + sticky headers ---
await page.locator(".side-sec-toggle").first().click();
await page.waitForTimeout(250);
check(await page.locator(".side-recent").count() === 0, "Recent collapses");
await page.locator(".side-sec-toggle").first().click();
await page.waitForTimeout(250);
check(await page.locator(".side-recent").count() === 1, "Recent re-expands");
check(
  await page.locator(".side-list-head").first().evaluate((el) => getComputedStyle(el).position) === "sticky",
  "section headers are sticky",
);

// --- #7 context menu ---
await page.locator('.side-tree [data-path="/v/README.md"]').click({ button: "right" });
await page.waitForTimeout(250);
const menu = await page.locator(".ctx-menu .ctx-label").allTextContents();
check(menu.includes("Rename…"), "context menu offers Rename");
check(menu.includes("Delete…"), "context menu offers Delete");
check(menu.includes("Copy path"), "context menu offers Copy path");
check(menu.includes("Reveal in file manager"), "context menu offers Reveal");
check(menu.some((m) => m.includes("Pin")), "context menu still offers Pin");
await page.keyboard.press("Escape");
await page.waitForTimeout(200);

// --- #8 folder open-state is carried by the chevron alone ---
const openFolderWeight = await aws.evaluate((el) => getComputedStyle(el).fontWeight);
const shutFolderWeight = await page
  .locator('.side-tree [data-path="/v/Docs"]')
  .evaluate((el) => getComputedStyle(el).fontWeight);
check(
  openFolderWeight === shutFolderWeight,
  `open and closed folders share one text weight (${openFolderWeight} vs ${shutFolderWeight})`,
);

// --- #13 windowing on a large tree ---
const many = Array.from({ length: 900 }, (_, i) => file(`f${i}.md`, `/v/big/f${i}.md`));
await seedTree([dir("big", "/v/big", many)]);
await page.locator(".side-tree .tree-item", { hasText: "big" }).first().click();
await page.waitForTimeout(500);
const rendered = await page.locator(".side-tree .tree-item").count();
check(rendered > 0 && rendered < 200, `900-file folder renders a window, not all rows (${rendered})`);
check(
  (await rowNames()).includes("f0.md"),
  "the first rows of a windowed list are present",
);

// --- missing Recent entries (deleted file still listed) ---
// The browser build has no filesystem, so drive the store's missing-set
// directly; the Rust `path_exists` side is exercised in the desktop app.
await page.evaluate(async () => {
  const mod = await import("/src/store.ts");
  mod.markMissing("/v/aws/README.md", true);
});
await page.waitForTimeout(300);
const missingRow = page.locator('.side-recent .tree-item.missing');
check(await missingRow.count() === 1, "a deleted Recent entry is marked missing");
check(
  (await missingRow.getAttribute("title")).startsWith("Missing —"),
  "missing row explains itself in its tooltip",
);
check(
  await missingRow.locator(".missing-icon").count() === 1,
  "missing row swaps its file glyph for a warning glyph",
);
check(
  await missingRow.locator(".tree-nm").evaluate((el) => getComputedStyle(el).textDecorationLine) === "line-through",
  "missing row strikes through the filename",
);
const liveOpacity = await page
  .locator(".side-recent .tree-item:not(.missing)")
  .first()
  .evaluate((el) => getComputedStyle(el).opacity);
const deadOpacity = await missingRow.evaluate((el) => getComputedStyle(el).opacity);
check(
  Number(deadOpacity) < Number(liveOpacity),
  `missing row is dimmer than a live one (${deadOpacity} vs ${liveOpacity})`,
);

// --- Remove from Recent ---
await missingRow.click({ button: "right" });
await page.waitForTimeout(250);
const recentMenu = await page.locator(".ctx-menu .ctx-label").allTextContents();
check(recentMenu.includes("Remove from Recent"), "Recent rows offer Remove from Recent");
await page.locator(".ctx-item", { hasText: "Remove from Recent" }).click();
await page.waitForTimeout(300);
check(
  await page.locator('.side-recent .tree-item.missing').count() === 0,
  "Remove from Recent drops the dead entry",
);

await browser.close();
kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
