/** Reproducible renderer coverage audit; known gaps are reported, not hidden as passing tests.
 * Run: node scripts/audit-markdown.mjs
 * Does not exercise browser geometry, native interaction, or async diagram SVG rendering.
 */
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const outdir = root + "tests/.build/markdown-audit";
await build({ entryPoints: [root + "src/markdown.ts", root + "src/livesource.ts", root + "src/tabletools.ts"], bundle: true, format: "esm", splitting: true, outdir });
const dom = new JSDOM("<!doctype html><body></body>");
for (const name of ["window", "document", "Node", "NodeFilter", "HTMLElement", "Text"]) globalThis[name] = name === "window" ? dom.window : dom.window[name];
const md = await import(outdir + "/markdown.js");
const live = await import(outdir + "/livesource.js");
const table = await import(outdir + "/tabletools.js");
const host = (html) => { const el = document.createElement("div"); el.innerHTML = html; return el; };
const has = (sel, n = 1) => (el) => el.querySelectorAll(sel).length === n;
const text = (s) => (el) => el.textContent.trim() === s;
const cases = [];
const add = (id, source, check, liveCheck = check) => cases.push({ id, source, check, liveCheck });
for (let n = 1; n <= 6; n++) add(`heading-h${n}`, "#".repeat(n) + " Heading", has(`h${n}`), has(`.md-layout-h${n}`));
add("setext-h1", "Heading\n=======", has("h1"), has(".md-layout-h1"));
add("setext-h2", "Heading\n-------", has("h2"), has(".md-layout-h2"));
add("closing-heading-hashes", "## Heading ##", text("Heading"));
add("strong", "**Bold**", has("strong"));
add("emphasis", "*Italic*", has("em"));
add("nested-emphasis", "**Bold and *italic***", has("strong em"));
add("triple-emphasis", "***Both***", (e) => !!e.querySelector("em strong, strong em"));
add("intraword-underscores", "some_variable_name", (e) => !e.querySelector("em") && e.textContent.trim() === "some_variable_name");
add("escaped-emphasis", "\\*literal\\*", (e) => !e.querySelector("em") && e.textContent.trim() === "*literal*");
add("html-entities", "AT&amp;T &#169;", text("AT&T ©"));
add("strike", "~~Old~~", has("del"));
add("highlight", "==Bright==", has("mark"));
add("subscript", "H~2~O", has("sub"));
add("superscript", "x^2^", has("sup"));
add("underline", "<u>Underlined</u>", has("u"));
add("underline-in-bold", "**<u>Both</u>**", has("strong u"));
add("code-single", "`a < b`", has("code"), has(".md-codespan"));
add("code-multi-backtick", "``a ` b``", (e) => e.querySelector("code")?.textContent === "a ` b", (e) => e.querySelector(".md-codespan")?.textContent === "a ` b");
add("code-multiline", "`a\nb`", (e) => e.querySelector("code")?.textContent === "a b", (e) => e.querySelector(".md-codespan")?.textContent === "a b");
add("link-inline", "[label](https://example.com)", has("a[href]"), has(".md-link"));
add("link-nested-parentheses", "[label](https://example.com/a_(b))", (e) => e.querySelector("a")?.getAttribute("href") === "https://example.com/a_(b)", text("label"));
add("reference-link", "[label][ref]\n\n[ref]: https://example.com", has("a[href]"), has(".md-link"));
add("reference-image", "![alt][ref]\n\n[ref]: image.png", has("img"), has("img"));
add("angle-autolink", "<https://example.com>", has("a"), has(".md-link"));
add("bare-autolink", "https://example.com", has("a"), has(".md-link"));
add("image-inline", "Text ![alt](image.png)", has("img"));
add("soft-break", "First\nsecond", (e) => !e.querySelector("br"), (e) => !e.querySelector("br, .md-hard-break"));
add("hard-break-spaces", "First  \nsecond", has("br"), has(".md-hard-break"));
add("hard-break-backslash", "First\\\nsecond", has("br"), has(".md-hard-break"));
add("horizontal-rule", "***", has("hr"));
add("unordered-list", "- A\n- B", has("li", 2), has(".md-list-item", 2));
add("ordered-start", "7. A\n8. B", has('ol[start="7"]'), has('[data-number="7."]'));
add("loose-list", "- A\n\n- B", has("ul", 1), has(".md-list", 1));
add("nested-list", "- A\n  - B", has("ul ul"), has(".md-list .md-list"));
add("tasks", "- [ ] A\n- [x] B", has('input[type="checkbox"]', 2), has(".md-task", 2));
add("quote", "> A\n>\n> B", has("blockquote"), has(".md-layout-quote"));
add("nested-quote", "> A\n> > B", has("blockquote blockquote"), has(".md-layout-quote .md-layout-quote"));
for (const kind of ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"]) add("alert-" + kind.toLowerCase(), `> [!${kind}]\n> Body`, has(".md-alert.md-alert-" + kind.toLowerCase()));
add("table-basic", "| A | B |\n| --- | --- |\n| 1 | 2 |", has("table"), has(".md-table"));
add("table-optional-pipes", "A | B\n--- | ---\n1 | 2", has("table"), has(".md-table"));
add("table-escaped-pipe", "| A | B |\n| --- | --- |\n| a\\|b | c |", (e) => e.querySelector("tbody td")?.textContent === "a|b", (e) => e.querySelectorAll(".md-trow:last-child .md-tcell").length === 2);
add("fenced-code", "```js\nconst a = 1;\n```", has("pre code"), has(".md-code-line"));
add("long-fence-with-short-inner", "````md\n```\n\ntext\n````", (e) => e.querySelector("pre code")?.textContent.includes("```\n\ntext"), has(".md-code-line", 3));
add("indented-code", "    first\n\n    second", (e) => e.querySelectorAll("pre").length === 1 && e.querySelector("pre code")?.textContent.includes("first\n\nsecond"), has(".md-layout-code"));
add("inline-math", "Value $x^2$ here", has(".katex"));
add("display-math", "$$\nx^2\n$$", has(".math-block .katex"));
add("math-blank-line", "$$\nx + y\n\n+ z\n$$", has(".math-block .katex"));
add("math-chemistry", "$\\ce{H2O}$", (e) => !!e.querySelector(".katex") && !e.querySelector(".math-error"));
add("math-physics", "$\\qty(x)$", (e) => !!e.querySelector(".katex") && !e.querySelector(".math-error"));
add("math-reference", "$\\ref{eq1}$", (e) => !!e.querySelector(".katex") && !e.querySelector(".math-error"));
add("mermaid", "```mermaid\ngraph TD; A-->B\n```", has("[data-mermaid]"));
add("d2", "```d2\na -> b\n```", has("[data-d2]"));
add("legacy-sequence", "```sequence\nA->B: hello\n```", has("svg, [data-sequence]"));
add("legacy-flow", "```flow\na=>start: Start\na->a\n```", has("svg, [data-flow]"));
add("emoji", ":smile:", (e) => e.textContent.includes("😄"));
add("footnote-document", "Text[^note].\n\n[^note]: A footnote", (e) => !!e.querySelector(".footnote-ref") && !!e.querySelector(".footnote-def"));
add("footnote-multiline", "[^note]: First\n\n    Second", (e) => e.querySelector(".footnote-def")?.textContent.includes("Second"));
add("repeated-footnote-reference", "First[^n] second[^n]", (e) => { const ids = [...e.querySelectorAll("[id]")].map((n) => n.id); return ids.length === 2 && ids.length === new Set(ids).size; });
add("frontmatter", "---\ntitle: Hello\n---", has(".front-matter"), has(".md-meta", 3));
add("toc-upper", "[TOC]", has("ul.toc"));
add("toc-lower", "[toc]", has("ul.toc"));
add("duplicate-heading-ids", "# Repeat\n\n# Repeat", (e) => { const ids = [...e.querySelectorAll("h1")].map((n) => n.id); return ids.length === 2 && new Set(ids).size === 2; });
add("html-kbd", "Press <kbd>Enter</kbd>", has("kbd"));
add("html-ruby", "<ruby>漢<rt>kan</rt></ruby>", has("ruby rt"));
add("html-details", "<details>\n<summary>More</summary>\n\nText\n\n</details>", (e) => e.querySelector("details")?.textContent.includes("Text") && !!e.querySelector("summary"));
add("html-video", '<video controls src="movie.mp4"></video>', has("video[controls]"));
add("html-audio", '<audio controls src="sound.mp3"></audio>', has("audio[controls]"));
add("html-iframe", '<iframe src="https://example.com"></iframe>', has("iframe"));
add("html-comment", "Before <!-- hidden --> after", text("Before  after"));
add("html-br", "First<br>Second", has("br"));
add("html-span-style", '<span style="color:red">Red</span>', (e) => [...e.querySelectorAll("span")].some(n => n.style.color === "red"));
add("nested-quote-in-alert", "> [!NOTE]\n> Intro\n>\n> > Quoted\n>\n> After", (e) => !!e.querySelector(".md-alert blockquote") && e.querySelector(".md-alert")?.textContent.includes("After"), (e) => !!e.querySelector(".md-alert .md-layout-quote"));
add("inline-image-title", '![Alt](image.png "Title")', has('img[title="Title"]'));
add("link-title", '[Label](https://example.com "Title")', has('a[title="Title"]'), text("Label"));
add("escaped-html", "&lt;script&gt;", text("<script>"));
add("unsafe-script-filtered", '<script>alert(1)</script>\n\nSafe', (e) => !e.querySelector("script"), null);
add("toc-inside-document", "# Example\n\n[TOC]\n\nText", has("ul.toc"));
add("preserve-line-breaks-option", "First\nsecond", has("br"), has("br, .md-hard-break"));
cases.at(-1).setup = () => md.setPreserveBreaksOption(true);
add("alternate-inline-math-option", String.raw`Value \(x+1\) here`, has(".katex"));
cases.at(-1).setup = () => md.setMathAltDelimiters(true);
add("math-fence-option", "```math\nx+1\n```", has(".math-block .katex"));
cases.at(-1).setup = () => md.setMathFence(true);
md.setTocProvider(() => [{ level: 1, text: "Example", blockIndex: 0 }]);
const results = [];
for (const c of cases) {
  md.setHtmlEmbeds(false);
  if (c.id === "html-iframe") md.setHtmlEmbeds(true);
  md.setPreserveBreaksOption(false); md.setMathAltDelimiters(false); md.setMathFence(false);
  c.setup?.();
  const blocks = md.splitBlocks(c.source);
  const documents = blocks.map((text, id) => ({ text, id }));
  md.setMarkdownDocumentProvider(() => documents);
  const preview = host(md.renderMarkdown(c.source));
  const perBlock = host(blocks.map((block, id) => md.renderMarkdown(block, String(id))).join("\n"));
  const liveHtml = live.styleSource(c.source);
  const liveHost = host(liveHtml);
  const roundtrip = liveHost.textContent === c.source;
  const visible = liveHost.cloneNode(true);
  // Account for CSS-generated glyphs and the code span's whitespace model.
  visible.querySelectorAll(".md-generated").forEach(el => { el.textContent = el.getAttribute("data-visible") ?? ""; });
  visible.querySelectorAll(".md-codespan").forEach(el => { el.textContent = el.textContent.replace(/\n/g, " "); });
  visible.querySelectorAll(".md-mark, .md-layout-space, .md-tsep").forEach((el) => el.remove());
  results.push({ id: c.id, preview: !!c.check(preview), editorPreview: !!c.check(perBlock), liveStructure: c.liveCheck ? !!c.liveCheck(visible) : null, sourcePreserved: roundtrip, blocks: blocks.length, source: c.source });
}
const extras = {
  setextOutline: md.extractOutline(["Heading\n======="]).length,
  tableEscapedPipeFirstCell: table.parseTable("| A | B |\n| --- | --- |\n| a\\|b | c |")?.rows.at(-1)?.[0],
  tableEscapedPipeColumns: table.parseTable("| A | B |\n| --- | --- |\n| a\\|b | c |")?.rows.at(-1)?.length,
  taskToggleIgnoresCode: md.toggleTask("`[ ]` example\n- [ ] Task", 0) === "`[ ]` example\n- [x] Task",
  longFenceStillOpen: md.hasOpenFence("````md\n```"),
};
const summary = { cases: results.length, preview: results.filter((r) => r.preview).length, editorPreview: results.filter((r) => r.editorPreview).length, liveStructure: results.filter((r) => r.liveStructure).length, sourcePreserved: results.filter((r) => r.sourcePreserved).length };
await mkdir(root + "docs", { recursive: true });
await writeFile(root + "docs/markdown-audit-results.json", JSON.stringify({ summary, extras, results }, null, 2) + "\n");
await writeFile(root + "docs/markdown-rendering-fixtures.md", "# Markdown rendering audit fixtures\n\nUse each sample to compare inactive preview, clicking into it, editing, and exporting. Some examples intentionally exercise unsupported behavior.\n\n" + cases.map((c) => `## ${c.id}\n\n${c.source}\n`).join("\n"));
console.log(JSON.stringify({ summary, extras, gaps: results.filter((r) => !r.preview || !r.editorPreview || r.liveStructure === false || !r.sourcePreserved).map(({source, ...r}) => r) }, null, 2));
