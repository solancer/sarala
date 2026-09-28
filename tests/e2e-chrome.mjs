/**
 * Live-app check of the floating window chrome.
 *
 *   node tests/e2e-chrome.mjs   (starts its own server on :1442)
 *
 * The sidebar owns the full window height; the content pane opens with a solid
 * document toolbar (tabs + controls) that sits above the editor scroller rather
 * than floating over it. These checks pin that layout and the controls in it.
 */
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const PORT = 1442;
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
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
page.on("pageerror", (e) => console.log("[pageerror]", e.message));
await page.goto(`http://localhost:${PORT}`);
await page.waitForSelector(".app");

let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? "PASS" : "FAIL"}: ${label}`);
  if (!cond) failures++;
};
const css = (sel, prop) =>
  page.locator(sel).evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop);
// The theme's accent, resolved to rgb() so it compares with computed colours.
const accent = () => page.evaluate(() => {
  const probe = document.createElement("span");
  probe.style.color = "var(--accent)";
  document.querySelector(".app").appendChild(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
});

// --- the sheet: sidebar and content both reach the top ---
const side = await page.locator(".sidebar").boundingBox();
const main = await page.locator(".main").boundingBox();
const bar = await page.locator(".topfloat").boundingBox();
check(side.y === 0, `the sidebar starts at the window top (${side.y})`);
check(main.y === 0, `the content pane starts at the window top (${main.y})`);
check(bar.y === 0, "the controls float at the very top of the content pane");
check(
  Math.abs(side.height - main.height) < 2,
  "sidebar and content pane are the same height (no band above either)",
);

// --- the document toolbar: a solid panel band above the editor ---
check(
  (await css(".topfloat", "background-color")) !== "rgba(0, 0, 0, 0)",
  "the document toolbar is a solid band, not see-through",
);
check(
  (await css(".topfloat", "box-shadow")).includes("inset"),
  "a hairline rule separates the toolbar from the page",
);
const pageBg = await css(".main", "background-color");
check(pageBg === "rgb(250, 246, 239)", `the pane is the editor page colour (${pageBg})`);
{
  const strip = await page.locator(".topfloat").boundingBox();
  const scroller = await page.locator(".main .scroll").first().boundingBox();
  check(scroller.y >= strip.y + strip.height - 1, `the editor scrolls below the toolbar, not under it (${strip.y + strip.height} / ${scroller.y})`);
}

// The strip is the window's drag handle, so it must take pointer events:
// Tauri's drag script reads the mouse event's target, and a `pointer-events:
// none` strip never becomes one — dragging and double-click-to-zoom both die.
check(
  (await css(".topfloat", "pointer-events")) !== "none",
  "the drag strip receives pointer events",
);
check(
  (await page.getAttribute(".topfloat", "data-tauri-drag-region")) === "deep",
  "the strip is a deep drag region, so the filename and spacer drag too",
);
check(
  (await page.locator(".topfloat").evaluate((el) => getComputedStyle(el, "::before").display)) === "none",
  "the old floating gradient mask is switched off",
);

// --- controls still work from their new home ---
await page.locator(".view-toggle button", { hasText: "Source" }).click();
await page.waitForTimeout(400);
check(await page.locator(".source-full").isVisible(), "Live/Source still switches views");
await page.locator(".view-toggle button", { hasText: "Live" }).click();
await page.waitForTimeout(400);

// --- collapsing the sidebar leaves the pane full width, controls still at top ---
await page.locator(".topfloat .topbar-toggle").first().click();
await page.waitForTimeout(700);
const mainC = await page.locator(".main").boundingBox();
check(mainC.x === 0, `the pane takes the full width when collapsed (x=${mainC.x})`);
check(
  (await page.locator(".topfloat").boundingBox()).y === 0,
  "the controls stay pinned to the top when collapsed",
);
await page.locator(".topfloat .topbar-toggle").first().click();
await page.waitForTimeout(700);

// --- the sidebar's top band drags too ---
check(
  (await page.getAttribute(".side-ws-head", "data-tauri-drag-region")) === "deep",
  "the sidebar's header is a deep drag region",
);
check(
  (await css(".side-ws-head", "pointer-events")) !== "none",
  "the sidebar's header receives pointer events",
);
{
  // Both bands the same height, so the draggable strip reads as continuous.
  const head = await page.locator(".side-ws-head").boundingBox();
  const strip = await page.locator(".topfloat").boundingBox();
  check(
    Math.abs(head.height - strip.height) < 1,
    `sidebar header and content strip are the same height (${head.height} vs ${strip.height})`,
  );
  check(head.y === 0, `the sidebar header starts at the window top (${head.y})`);
}
// The New-file button must stay a control, not a drag handle.
check(
  (await page.getAttribute(".side-ws-head .side-icon-btn", "data-tauri-drag-region")) === null,
  "the New-file button is not itself marked draggable",
);

// --- unsaved indicator ---
// It used to render always and only swap --select for --accent. Those resolve
// to the same colour on the default theme, and on the five themes that never
// define --select, so "unsaved" looked identical to "saved" on 6 of 13 themes.
await page.evaluate(async () => {
  const m = await import("/src/store.ts");
  m.setFilePath("/Users/me/notes/README.md");
});
await page.waitForTimeout(300);
const dot = '.document-tab.selected .document-tab-dirty.dirty';
check(await page.locator(dot).count() === 0, "a saved document shows no dot");
await page.locator(".block").first().click();
await page.waitForSelector(".block.active .source");
await page.keyboard.type("x");
await page.waitForTimeout(400);
check(await page.locator(dot).count() === 1, "editing shows the unsaved dot");
check(
  (await page.getAttribute(dot, "aria-label")) === "Unsaved changes",
  "the dot says what it means",
);
// --accent is defined by every theme; --select is not, which is what broke it.
check(
  (await css(dot, "background-color")) === await accent(),
  "the dot uses --accent, which every theme defines",
);

// --- filename carries its path ---
check(
  (await page.getAttribute('.document-tab.selected [role="tab"]', "title")) === "/Users/me/notes/README.md",
  "the tab's tooltip disambiguates same-named files",
);

// --- landmark semantics survived the float rewrite ---
check(
  await page.locator("header.topfloat").count() === 1,
  "the strip is a <header> landmark, not a bare div",
);
check(
  (await page.getAttribute("header.topfloat", "aria-label")) === "Documents and controls",
  "the landmark is named",
);

// --- grouping: global action separated from view controls ---
check(
  await page.locator(".topfloat-sep").count() === 1,
  "a divider separates the command palette from the view controls",
);
{
  const order = await page.locator(".document-header-actions > *").evaluateAll((els) =>
    els.map((e) => e.className.split(" ")[0] || e.tagName.toLowerCase()),
  );
  const sep = order.indexOf("topfloat-sep");
  const palette = order.indexOf("topbar-search");
  const views = order.indexOf("view-toggle");
  check(palette < sep && sep < views, `palette | divider | view controls (${order.join(",")})`);
}

// --- status bar ---
// "Markdown" was hardcoded, but the app opens .txt (drag-drop, and the Rust
// tree walker lists them), so the label was simply wrong for those files.
await page.evaluate(async () => {
  const m = await import("/src/store.ts");
  m.setFilePath("/n/notes.txt");
});
await page.waitForTimeout(300);
check(
  (await page.locator(".sb-fmt").textContent()).startsWith("Plain text"),
  `a .txt file reports its real format (${(await page.locator(".sb-fmt").textContent()).trim()})`,
);
await page.evaluate(async () => {
  const m = await import("/src/store.ts");
  m.setFilePath("/n/README.md");
});
await page.waitForTimeout(300);
check(
  (await page.locator(".sb-fmt").textContent()).startsWith("Markdown"),
  "a .md file still reports Markdown",
);

// Controls vs readouts: the row used to be four identical-looking items of
// which only two were clickable.
check(await page.locator("button.sb-saved").count() === 1, "the saved state is a real button");
// Force a clean buffer — earlier checks in this file typed into the document.
await page.evaluate(async () => {
  const m = await import("/src/store.ts");
  m.setDocDirty(false);
});
await page.waitForTimeout(300);
check(
  await page.locator("button.sb-saved").isDisabled(),
  "a saved document offers no save action",
);
check(
  (await css(".sb-fmt", "cursor")) === "default",
  "the encoding readout does not present itself as a control",
);
// The saved dot was the one hardcoded colour in the bar; it now resolves
// through var(--ok, …) so a theme can override it. Checked in the clean state,
// where the dirty rule does not apply.
check(
  (await css(".sb-saved .sync-dot", "background-color")) === "rgb(53, 194, 109)",
  `the saved dot resolves through a themeable token (${await css(".sb-saved .sync-dot", "background-color")})`,
);
// And the dirty state uses the theme accent, not the same green.
await page.evaluate(async () => {
  const m = await import("/src/store.ts");
  m.setDocDirty(true);
});
await page.waitForTimeout(300);
check(
  (await css(".sb-saved .sync-dot", "background-color")) === await accent(),
  "the unsaved dot switches to the theme accent",
);
check(
  !(await page.locator("button.sb-saved").isDisabled()),
  "an unsaved document offers the save action",
);

// Consistency + a11y.
check(await page.locator(".sb-stat svg").count() === 0, "stats carry no arbitrary subset of icons");
check(
  (await page.getAttribute("footer.statusbar", "aria-label")) === "Document status",
  "the status bar is a named landmark",
);
check(
  await page.locator(".sb-dot:not([aria-hidden])").count() === 0,
  "decorative separators are hidden from assistive tech",
);
check(
  (await css(".sb-stats", "overflow")) === "hidden",
  "the stats group truncates rather than shoving the right-hand group off",
);

// --- the macOS traffic-light band ---
// That band only renders under Tauri+macOS, which this browser harness is not,
// so assert the two things that are checkable here: the dead padding that used
// to occupy it is gone, and Tauri's own drag-region algorithm resolves the
// band's markup the way we intend (draggable beside the lights, opted out over
// them). The algorithm below is copied from tauri-2.11.2 window/scripts/drag.js.
check(
  (await css(".sidebar", "padding-top")) === "0px",
  "the sidebar no longer reserves the band as dead padding",
);
const band = await page.evaluate(() => {
  const ATTR = "data-tauri-drag-region";
  const CLICKABLE = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY"]);
  const ROLES = new Set(["button", "link", "menuitem", "tab", "checkbox", "radio", "switch", "option"]);
  const clickable = (el) =>
    CLICKABLE.has(el.tagName) ||
    (el.hasAttribute("contenteditable") && el.getAttribute("contenteditable") !== "false") ||
    (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") ||
    ROLES.has(el.getAttribute("role"));
  const isDrag = (path) => {
    for (const el of path) {
      if (!(el instanceof HTMLElement)) continue;
      const a = el.getAttribute(ATTR);
      if (clickable(el) && a === null) return false;
      if (a === null) continue;
      if (a === "false") return false;
      if (a === "deep") return true;
      if (a === "" || a === "true") return el === path[0];
    }
    return false;
  };
  const chain = (el) => { const out = []; for (let n = el; n; n = n.parentElement) out.push(n); return out; };

  // Build the band exactly as Sidebar.tsx renders it under Tauri+macOS.
  const side = document.querySelector(".sidebar");
  const strip = document.createElement("div");
  strip.className = "side-traffic";
  strip.setAttribute(ATTR, "deep");
  const gap = document.createElement("span");
  gap.className = "side-traffic-gap";
  gap.setAttribute(ATTR, "false");
  strip.appendChild(gap);
  side.insertBefore(strip, side.querySelector(".side-ws-head"));

  const result = {
    overLights: isDrag(chain(gap)),
    besideLights: isDrag(chain(strip)),
    header: isDrag(chain(document.querySelector(".side-ws-name"))),
    newFileButton: isDrag(chain(document.querySelector(".side-ws-head .side-icon-btn"))),
    fileTree: isDrag(chain(document.querySelector(".side-tab-body"))),
  };
  strip.remove();
  return result;
});
check(!band.overLights, "the traffic lights opt out, so they keep their own clicks");
check(band.besideLights, "the band beside the lights drags (was dead space)");
check(band.header, "the workspace name drags");
check(!band.newFileButton, "the New-file button stays a control, not a drag handle");
check(!band.fileTree, "the file tree below is not a drag region");

// --- the old solid bar is gone entirely ---
check(await page.locator(".topbar").count() === 0, "the old solid top bar no longer exists");

// --- the editor scrollbar has its own lane and styling ---
// (Headless Chromium uses overlay scrollbars, so only the declared styling is
// checkable here; the toolbar no longer overlaps the scroller at all.)
{
  const w = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--scrollbar-w").trim(),
  );
  check(w === "10px", `the scrollbar lane has a declared width (${w})`);
  // `background: var(--rule)` does not survive CSSOM serialization (Chromium
  // drops the var() from the shorthand's longhands), so assert on the parts
  // that do — they are what distinguishes our thumb from the platform default.
  const thumb = await page.evaluate(() => {
    for (const sheet of document.styleSheets) {
      let rules; try { rules = sheet.cssRules; } catch { continue; }
      for (const r of rules) {
        if (r.selectorText === ".scroll::-webkit-scrollbar-thumb") {
          return { clip: r.style.backgroundClip, radius: r.style.borderRadius };
        }
      }
    }
    return null;
  });
  check(
    thumb?.clip === "content-box" && thumb.radius === "99px",
    `the editor scroller has its own styled thumb (${JSON.stringify(thumb)})`,
  );
}

// --- motion ---
// Durations were ad-hoc across the sheet and overlays had no entrance at all.
const tokens = await page.evaluate(() => {
  const cs = getComputedStyle(document.documentElement);
  return {
    d1: cs.getPropertyValue("--dur-1").trim(),
    d2: cs.getPropertyValue("--dur-2").trim(),
    d3: cs.getPropertyValue("--dur-3").trim(),
    easeOut: cs.getPropertyValue("--ease-out").trim(),
  };
});
check(
  tokens.d1 === "90ms" && tokens.d2 === "150ms" && tokens.d3 === "220ms",
  `motion runs on a three-step scale (${tokens.d1}/${tokens.d2}/${tokens.d3})`,
);
check(tokens.easeOut.startsWith("cubic-bezier"), "entrances use a decelerating curve");

const anim = async (sel) =>
  page.locator(sel).evaluate((el) => {
    const s = getComputedStyle(el);
    return { name: s.animationName, dur: s.animationDuration };
  });

await page.evaluate(async () => {
  const m = await import("/src/components/ThemePicker.tsx");
  m.openThemePicker();
});
await page.waitForTimeout(200);
const dialog = await anim(".theme-picker");
check(dialog.name === "ov-dialog", `dialogs settle into place (${dialog.name})`);
check(dialog.dur === "0.22s", `dialogs use the large-surface duration (${dialog.dur})`);
check((await anim(".settings-backdrop")).name === "ov-fade", "the backdrop fades under them");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// Anchored surfaces move relative to what they belong to: menus rise from
// their trigger, the selection toolbar descends onto the selection above which
// it sits.
await page.locator(".block").first().click();
await page.waitForSelector(".block.active .source");
// A leading space: earlier checks left text in this block, and the slash only
// triggers at a line start or after whitespace (so paths and URLs do not fire).
await page.keyboard.type(" /");
await page.waitForTimeout(400);
check((await anim(".slash-menu")).name === "ov-rise", "the slash menu rises from the caret");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// The documented WebKitGTK constraint must survive: animating a text row's
// repaint flips it from subpixel to grayscale antialiasing, so hover on
// text-bearing rows stays instant.
const rowDur = await page.evaluate(() => {
  const el = document.createElement("div");
  el.className = "tree-item";
  document.querySelector(".sidebar").appendChild(el);
  const d = getComputedStyle(el).transitionDuration;
  el.remove();
  return d;
});
check(rowDur === "0s", `text rows keep instant hover (${rowDur})`);

await browser.close();

// --- reduced motion ---
// Previously honoured only by the sidebar. Zeroing the tokens should collapse
// everything written against them, without touching each rule.
{
  const quiet = await chromium.launch();
  const qp = await quiet.newPage({ reducedMotion: "reduce" });
  await qp.goto(`http://localhost:${PORT}`);
  await qp.waitForSelector(".app");
  const t = await qp.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    return ["--dur-1", "--dur-2", "--dur-3"].map((k) => cs.getPropertyValue(k).trim());
  });
  check(t.every((v) => v === "0ms"), `reduced motion zeroes the scale (${t.join(",")})`);
  const sidebarDur = await qp.locator(".sidebar").evaluate((el) => getComputedStyle(el).transitionDuration);
  check(parseFloat(sidebarDur) < 0.01, `and collapses real transitions (${sidebarDur})`);
  await quiet.close();
}

kill();
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed");
process.exit(failures ? 1 : 0);
