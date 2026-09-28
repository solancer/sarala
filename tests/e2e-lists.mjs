/** List activation must preserve layout, source, numbering and click position. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chromium, webkit } from "playwright";

const port = 1432;
const server = spawn("node", ["node_modules/vite/bin/vite.js", "--port", String(port), "--strictPort"], { stdio: "pipe" });
server.stderr.on("data", (d) => process.stderr.write(d));
try {
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Vite startup timed out")), 20000);
    server.stdout.on("data", (d) => { if (String(d).includes("Local:")) { clearTimeout(timeout); resolve(); } });
    server.on("exit", (code) => { clearTimeout(timeout); reject(new Error(`Vite exited: ${code}`)); });
  });
  
  for (const engine of process.env.WEBKIT ? [webkit] : [chromium]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 1000 } });
      await page.goto(`http://localhost:${port}`);
      await page.waitForSelector(".block");
      await page.evaluate(() => document.fonts.ready);
      const load = async (text) => {
        await page.evaluate(async (text) => {
          const store = await import("/src/store.ts");
          store.loadDocument(text, null);
          store.setActive(-1);
        }, text);
      };
      const position = (needle) => page.evaluate((needle) => {
        const walker = document.createTreeWalker(document.querySelector(".page"), NodeFilter.SHOW_TEXT);
        for (let node; (node = walker.nextNode());) {
          const i = node.data.indexOf(needle);
          if (i < 0) continue;
          const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + needle.length);
          const box = r.getBoundingClientRect();
          return { x: box.x, y: box.y, height: box.height, width: box.width };
        }
        throw new Error(`Missing text: ${needle}`);
      }, needle);
      const snap = "The snap is **not** built in GitHub Actions. It is built by the **Snap Store\nbuild service**, which builds `snap/snapcraft.yaml` (a `core22` build) on **amd64** and **arm64**. One-time setup:";
      const fixtures = [
        ...["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"].map((type) => [`> [!${type}]\n> Callout body with **bold** text.\n> Another line.`, ["Callout body", "bold", "Another line."]]),
        ["> First paragraph\n>\n> Second paragraph", ["First paragraph", "Second paragraph"]],
        ["> Parent\n> > Nested quote", ["Parent", "Nested quote"]],
        ["Reading material for this <u>article</u>, so `readers` can follow. " + "More paragraph text. ".repeat(12), ["Reading material", "article", "can follow."]],
        ["- First bullet\n- Second bullet\n- Third bullet", ["First bullet", "Second bullet", "Third bullet"]],
        ["- Parent with `code`\n  - Child one\n  - Child two\n- Final sibling", ["Parent with", "Child one", "Child two", "Final sibling"]],
        [snap, ["The snap is", "One-time setup:", "build service"]],
        ["- " + snap + "\n- Next item", ["The snap is", "Next item", "build service"]],
        ["4) " + snap + "\n1) Next item", ["The snap is", "Next item", "build service"]],
        ["### 1.1 Tech stack\n- **Language:** Java and Spring\n- **Modules:** " + "several services with shared dependencies ".repeat(4) + "wrapend\n- Last item", ["1.1 Tech stack", "Java and Spring", "wrapend", "Last item"]],
        ["9) Alpha\n1) Bravo " + "long numbered section text ".repeat(6) + "wrapend\n1) Charlie", ["Alpha", "Bravo", "wrapend", "Charlie"]],
        ["- Parent\n  - Nested\n    3. Deep\n    1. Again\n- Sibling", ["Parent", "Nested", "Deep", "Again", "Sibling"]],
        ["1. First loose item\n\n1. Second loose item", ["First loose item", "Second loose item"]],
        ["- [ ] Task first\n- [x] Task second", ["Task first", "Task second"]],
        ["## 2. Numbered section\n- Alpha\n- Bravo", ["2. Numbered section", "Alpha", "Bravo"]],
      ];
      for (const [text, needles] of fixtures) {
        await load(text);
        const before = await Promise.all(needles.map(position));
        const target = before[before.length - 1];
        await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
        await page.waitForSelector(".source");
        assert.equal(await page.locator(".source").textContent(), text);
        assert.equal(await page.locator(".source .md-on").count(), 0, "text click keeps syntax concealed");
        for (let i = 0; i < needles.length; i++) {
          const after = await position(needles[i]);
          assert.ok(Math.abs(after.x - before[i].x) < 1, `${needles[i]} x: ${before[i].x} → ${after.x}`);
          assert.ok(Math.abs(after.y - before[i].y) < 1, `${needles[i]} y: ${before[i].y} → ${after.y}`);
        }
        const caret = await page.evaluate(async () => {
          const { getCaretOffset } = await import("/src/livesource.ts");
          return getCaretOffset(document.querySelector(".source"));
        });
        assert.ok(caret >= text.indexOf(needles.at(-1)), `Click lands in last item: ${caret}`);
        assert.ok(caret < text.length, `Click does not jump to end: ${caret}`);
        await page.keyboard.insertText("Z");
        assert.equal(await page.locator(".source").textContent(), text.slice(0, caret) + "Z" + text.slice(caret));
        await page.keyboard.press("Escape");
        console.log(`PASS layout, click and edit: ${text.split("\n")[0]}`);
      }
      // A snippet nested in a list keeps its box and token colors when a
      // different line in that list is clicked (RELEASING.md regression).
      for (const prefix of ["1.", "-"]) {
        const indent = " ".repeat(prefix.length + 1);
        const text = `${prefix} **Register the name** once:\n\n${indent}\`\`\`sh\n${indent}snapcraft register sarala\n${indent}\`\`\`\n\n${prefix} Connect at <https://snapcraft.io/sarala/builds>.`;
        await load(text);
        await page.waitForSelector(".rendered pre.shiki code span[style*='color']");
        const metrics = (selector) => page.locator(selector).evaluate((el) => {
          const box = el.getBoundingClientRect(); const css = getComputedStyle(el);
          return { x: box.x, y: box.y, width: box.width, height: box.height,
            background: css.backgroundColor, padding: css.padding, border: css.borderRadius,
            font: css.fontSize, lineHeight: css.lineHeight };
        });
        const before = await metrics(".rendered pre.shiki");
        const word = await position("once:");
        await page.mouse.click(word.x + word.width / 2, word.y + word.height / 2);
        await page.waitForSelector(".source .md-layout-code");
        assert.deepEqual(await metrics(".source .md-layout-code"), before, "nested snippet retains its box geometry and typography");
        assert.ok(await page.locator(".source .md-code-content span[style*='color']").count(), "nested code stays highlighted");
        assert.equal(await page.locator(".source .md-fence.md-on").count(), 0);
        assert.equal(await page.locator(".source").textContent(), text);
        await page.keyboard.press("Escape");
        console.log(`PASS nested code activation: ${prefix}`);
      }
      await load("9) First\n10) Second");
      await page.evaluate(async () => {
        const store = await import("/src/store.ts");
        store.requestCaret(store.doc.blocks[0].text.length); store.setActive(0);
      });
      await page.keyboard.press("Enter");
      await page.keyboard.insertText("Third");
      assert.equal(await page.locator(".source").textContent(), "9) First\n10) Second\n11) Third");
      await page.keyboard.press("Enter");
      await page.keyboard.press("Enter");
      assert.equal(await page.locator(".source").textContent(), "");
      console.log("PASS ordered continuation and empty-item exit");
    } finally { await browser.close(); }
  }
} finally { server.kill("SIGTERM"); }
