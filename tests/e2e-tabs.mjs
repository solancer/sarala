/** Real UI checks for tab controls, source buffers, shortcuts, and close guards. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
const port = 1433;
const server = spawn("node", ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"], { stdio: "pipe" });
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Vite startup timed out")), 20000);
    server.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(timer); resolve(); } });
    server.stderr.on("data", (d) => process.stderr.write(d));
    server.on("exit", (code) => { clearTimeout(timer); reject(new Error(`Vite exited: ${code}`)); });
  });
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://localhost:${port}`);
  await page.waitForSelector('[role="tab"]');
  // The sidebar's view switcher is also a tablist; count document tabs only.
  const docTabs = page.getByRole("tablist", { name: "Open documents" });
  await page.evaluate(async () => {
    const store = await import("/src/store.ts");
    store.openDocument("Alpha", "/notes/A.md");
    store.openDocument("Beta", "/notes/B.md");
  });
  assert.equal(await docTabs.getByRole("tab").count(), 2);
  await page.getByRole("button", { name: "Source", exact: true }).click();
  await page.locator(".source-full").fill("Beta edited");
  await docTabs.getByRole("tab", { name: /A.md/ }).click();
  assert.equal(await page.locator(".rendered").textContent().then((s) => s.trim()), "Alpha");
  await docTabs.getByRole("tab", { name: /B.md/ }).click();
  assert.equal(await page.locator(".source-full").inputValue(), "Beta edited\n");
  page.once("dialog", (dialog) => dialog.dismiss());
  // Keyboard path (deletable tabs): Delete on the focused tab.
  await docTabs.getByRole("tab", { name: /B.md/ }).focus();
  await page.keyboard.press("Delete");
  assert.equal(await docTabs.getByRole("tab").count(), 2, "cancel keeps dirty tab");
  page.once("dialog", (dialog) => dialog.accept());
  // Pointer path: the ✕ on the tab.
  await page.locator(".document-tab", { hasText: "B.md" }).locator(".document-tab-close").click();
  await docTabs.getByRole("tab", { name: /B.md/ }).waitFor({ state: "detached" });
  assert.equal(await docTabs.getByRole("tab").count(), 1);
  await page.keyboard.press("Control+t");
  assert.equal(await docTabs.getByRole("tab").count(), 2, "new tab shortcut");
  await page.keyboard.press("Control+Tab");
  assert.match(await docTabs.locator('[role="tab"][aria-selected="true"]').textContent(), /A.md/);
  await page.locator(".document-tab", { hasText: "A.md" }).locator(".document-tab-close").click();
  await page.locator(".document-tab", { hasText: "Untitled.md" }).locator(".document-tab-close").click();
  assert.equal(await docTabs.getByRole("tab").count(), 1, "last close leaves blank tab");
  assert.match(await docTabs.locator('[role="tab"][aria-selected="true"]').textContent(), /Untitled.md/);
  console.log("PASS tab switching, source edits, close protection and shortcuts");
} finally { await browser?.close(); server.kill("SIGTERM"); }
