import { build } from "esbuild";
import { JSDOM } from "jsdom";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const outdir = root + "tests/.build/regressions";
await build({ entryPoints: ["markdown", "livesource", "tabletools", "frontmatter", "legacydiagrams", "imageupload"].map(n => root + `src/${n}.ts`), bundle: true, format: "esm", splitting: true, outdir });
const dom = new JSDOM("<!doctype html><body></body>");
for (const name of ["window", "document", "Node", "NodeFilter", "HTMLElement", "Text"]) globalThis[name] = name === "window" ? dom.window : dom.window[name];
const md = await import(outdir + "/markdown.js");
const live = await import(outdir + "/livesource.js");
const table = await import(outdir + "/tabletools.js");
const yaml = await import(outdir + "/frontmatter.js");
const diagrams = await import(outdir + "/legacydiagrams.js");
const upload = await import(outdir + "/imageupload.js");
const host = html => { const el = document.createElement("div"); el.innerHTML = html; return el; };
let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const equal = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++; };

for (const [source, nth, expected] of [
  ["`[ ]` example\n- [ ] Task", 0, "`[ ]` example\n- [x] Task"],
  ["```md\n- [ ] code\n```\n\n- [ ] real", 0, "```md\n- [ ] code\n```\n\n- [x] real"],
  ["- [ ] parent\n  - [ ] child\n  - [x] next", 1, "- [ ] parent\n  - [x] child\n  - [x] next"],
  ["> - [ ] quoted\n> - [x] done", 1, "> - [ ] quoted\n> - [ ] done"],
  ["    - [ ] code\n\n- [ ] real", 0, "    - [ ] code\n\n- [x] real"],
]) equal(md.toggleTask(source, nth), expected, "Only the parsed task marker is toggled");

const escaped = "| A | B |\n| --- | ---: |\n| a\\|b | c |\n| d | e |";
equal(table.parseTable(escaped).rows[1], ["a\\|b", "c"], "Escaped pipe cell content survives parsing");
equal(table.parseTable(table.serializeTable(table.parseTable(escaped))), table.parseTable(escaped), "Table serialization is lossless");
equal(table.cellRanges(escaped).map(r => escaped.slice(r.start,r.end)), ["A","B","a\\|b","c","d","e"], "Cell navigation uses structural pipes");
equal(table.columnAtOffset(escaped, escaped.indexOf("b |")), 0, "Escaped pipe does not change caret column");
equal(table.parseTable(table.moveTablePart(escaped,"column",0,1)).rows[1], ["c","a\\|b"], "Column movement preserves cells");
equal(table.parseTable(table.moveTablePart(escaped,"column",0,1)).align, ["right",null], "Column movement carries alignment");
equal(table.parseTable(table.moveTablePart(escaped,"row",1,2)).rows[2], ["a\\|b","c"], "Row movement preserves cells");
equal(table.moveTablePart(escaped,"row",0,1), escaped, "Header cannot become a body row");

for (const source of ["````md\n```\n\ntext\n````", "$$\nx+y\n\n+z\n$$", "    first\n\n    second", "<details>\n<summary>More</summary>\n\nBody\n\n</details>", "[^n]: First\n\n    Second"]) equal(md.splitBlocks(source), [source], "Syntax container stays in one editable block");
check(md.hasOpenFence("````md\n```"), "Short fence cannot close a longer fence");
check(md.hasOpenFence("```js\n```no"), "Closing fence cannot have info text");
check(!md.hasOpenFence("~~~js\nx\n~~~~"), "Longer matching fence closes the block");
equal(md.extractOutline(["Title\n====="]), [{level:1,text:"Title",blockIndex:0}], "Setext headings appear in outline");

const source = "# Repeat\n\n[label][ref]\n\nText[^n] again[^n].\n\n# Repeat\n\n[toc]\n\n[^n]: First\n\n    Second\n\n[ref]: https://example.com";
const blocks = md.splitBlocks(source).map((text,id) => ({text,id}));
md.setMarkdownDocumentProvider(() => blocks);
const preview = host(blocks.map(b => md.renderMarkdown(b.text,String(b.id))).join(""));
check(preview.querySelector('a[href="https://example.com"]'), "Reference destination resolves across blocks");
equal([...preview.querySelectorAll("h1")].map(n => n.id), ["repeat","repeat-1"], "Editor heading IDs are unique across blocks");
equal([...preview.querySelectorAll(".toc a")].map(n => n.hash), ["#repeat","#repeat-1"], "TOC matches duplicate anchors");
const ids = [...preview.querySelectorAll("[id]")].map(n=>n.id);
equal(new Set(ids).size, ids.length, "Footnote references have unique IDs");
check(preview.querySelector(".footnote-def").textContent.includes("Second"), "Multiline footnote retained");
check(preview.querySelector(".footnote-ref a").title.includes("Second"), "Footnote preview includes continuation");
check(host(md.renderMarkdown(source)).querySelector(".footnote-def"), "Whole-document export includes footnotes");
check(host(live.styleSource("[label][ref]")).querySelector(".md-link"), "Live references share document definitions");
md.setMarkdownDocumentProvider(() => []);
const alert = host(md.renderMarkdown("> [!NOTE]\n> Before\n>\n> > Nested\n>\n> After"));
check(alert.querySelector(".md-alert").textContent.includes("After"), "Nested quote cannot terminate an alert early");

for (const [source, selector] of [["**Bold and *italic***","strong em"],["***Both***","em strong, strong em"],["**<u>Both</u>**","strong u"],["``a ` b``",".md-codespan"],["<kbd>Ctrl</kbd>","kbd"],["![Alt](image.png \"Title\")",'img[title="Title"]'],["Heading\n===",".md-layout-h1"],["***","hr"]]) {
  const el = host(live.styleSource(source));
  equal(el.textContent,source,"Live decoration retains original source");
  check(el.querySelector(selector),`Live structure: ${source}`);
}
for (const source of ["some_variable_name", "\\*literal\\*"]) check(!host(live.styleSource(source)).querySelector("em"), "Literal punctuation is not emphasis");
for (const source of ["AT&amp;T &#169;", ":smile:", "A[^n]", "| a | b |\n| --- | --- |\n| a\\|b | c |", "<span style=\"color:red\">Red</span>"]) equal(host(live.styleSource(source)).textContent, source, "Generated glyphs and tables preserve source offsets");
check(host(live.styleSource('<span style="color:red">Red</span>')).querySelector('span[style="color:red;"]'), "Inline color remains styled");
equal(live.mapRenderedPrefixToSource("AT&amp;T next", "AT&T"), 8, "Caret mapping handles entities");
equal(live.mapRenderedPrefixToSource(":smile: next", "😄"), 7, "Caret mapping handles emoji");
md.setPreserveBreaksOption(true);
check(host(live.styleSource("one\ntwo")).querySelector(".md-hard-break"), "Line-break preference affects editing");
md.setPreserveBreaksOption(false);

for (const source of ["$\\ce{H2O}$", "$\\qty(x)$", "$\\dv{f}{x}$", "$\\bra{x}$"]) check(!host(md.renderMarkdown(source)).querySelector(".math-error"), "Supported chemistry/physics renders");
const equations = "$$x\\label{eq1}$$\n\n$\\ref{eq1}$";
check(host(md.renderMarkdown(equations)).querySelector('[id="eq-eq1"]'), "Equation labels have anchors");
check(!host(md.renderMarkdown(equations)).querySelector(".math-error"), "Equation references resolve");
check(host(md.renderMarkdown("```sequence\nA->B: Hello\n``` ")).querySelector("[data-mermaid][data-sequence]"), "Legacy sequence reaches diagram renderer");
check(diagrams.legacyDiagram("a=>start: Start\nb=>condition: Ready?\na->b\nb(yes)->a","flow").includes('n1 -->|"yes"| n0'), "Legacy flow branches retain labels");
assert.throws(()=>diagrams.legacyDiagram("unknown stuff","flow")); checks++;

const iframe = '<iframe src="https://example.com/embed" srcdoc="bad" onload="evil()" sandbox="allow-same-origin allow-top-navigation"></iframe>';
md.setHtmlEmbeds(false); check(!host(md.renderMarkdown(iframe)).querySelector("iframe"), "Embeds are off by default");
md.setHtmlEmbeds(true);
const frame = host(md.renderMarkdown(iframe)).querySelector("iframe");
equal(frame.getAttribute("sandbox"), "allow-scripts", "Embed has an opaque sandbox origin");
check(!frame.hasAttribute("srcdoc") && !frame.hasAttribute("onload"), "Embed cannot inject local markup/events");
check(!host(md.renderMarkdown('<iframe src="javascript:alert(1)"></iframe>')).querySelector("iframe"), "Embed rejects non-HTTPS URLs");
md.setHtmlEmbeds(false);
equal(yaml.parseYamlMetadata('---\noutput:\n  html: true\ntags: [one, two]\nsummary: |\n  First\n  Second\n---').tags,["one","two"],"YAML arrays and nested maps parse");
equal(yaml.parseFrontMatter('---\ntypora-root-url: "/images"\n---')["typora-root-url"],"/images","YAML image aliases preserved");
equal(yaml.parseYamlMetadata('---\nx: !!js/function function(){}\n---'),{},"Executable YAML tags are rejected");

let sent = 0;
const fakeFetch = async (_url, options) => { sent++; check(options.body instanceof FormData,"Upload uses multipart form"); equal(options.credentials,"omit","Upload sends no ambient credentials"); return {ok:true,json:async()=>({url:"https://images.example/a.png"})}; };
equal(await upload.uploadImageBlob("https://upload.example/",new Blob(["image"],{type:"image/png"}),"a.png",fakeFetch),"https://images.example/a.png","Upload validates returned URL");
await assert.rejects(()=>upload.uploadImageBlob("http://upload.example/",new Blob(["image"],{type:"image/png"}),"a.png",fakeFetch));checks++;
equal(sent,1,"Invalid destination does not send a file");
const equationHost = host(live.styleSource("Before $x^2$ after"));
live.hydrateInlinePreviews(equationHost, source => md.renderMarkdown(source), () => {});
equal(equationHost.textContent, "Before $x^2$ after", "Inline equation preview preserves editable source offsets");
check(equationHost.querySelector(".md-inline-preview").shadowRoot.querySelector(".katex"), "Inline equation retains rendered math when editing surrounding text");
console.log(`${checks} Markdown regression checks passed`);
