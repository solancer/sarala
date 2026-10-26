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
await md.prepareRender("$x$ :smile:"); // KaTeX and the emoji catalog load lazily
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
equal(md.extractOutline(["---\ntitle: Notes\n---", "# Real"]), [{level:1,text:"Real",blockIndex:1}], "Front matter is not an outline heading");
{
  const fm = ["---\ntitle: Notes\n---", "[TOC]", "# Real"].map((text, id) => ({ id, text }));
  md.setMarkdownDocumentProvider(() => fm);
  equal([...host(md.renderMarkdown(fm[1].text, "1")).querySelectorAll(".toc a")].map(n => n.textContent), ["Real"], "Front matter stays out of the TOC");
  md.setMarkdownDocumentProvider(() => []);
}

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
// Render-context signatures: a block re-renders only when its own sig changes,
// so every piece of document context it consumes must appear in that sig.
{
  const sigOf = (texts, i, path = null) => md.buildRenderContext(texts.map((text, id) => ({ id, text })), path).blocks.get(String(i)).sig;
  const base = ["# Intro", "See [the docs][ref] and $$a$$", "Plain words only", "[ref]: https://a.example", "Note[^n]", "[^n]: First", "# Intro", "$$b \\label{eq:b}$$", "Cite $\\eqref{eq:b}$", "![pic](img.png)"];
  const edit = (i, text) => base.map((t, j) => j === i ? text : t);
  check(sigOf(base, 2) === sigOf(edit(0, "# Changed"), 2), "Unrelated edit leaves a plain block's sig alone");
  check(sigOf(base, 1) !== sigOf(edit(3, "[ref]: https://b.example"), 1), "Reference definition change re-renders its users");
  check(sigOf(base, 4) !== sigOf(edit(5, "[^n]: Second"), 4), "Footnote text change re-renders its reference");
  check(sigOf(base, 6) !== sigOf(edit(0, "# Other"), 6), "Duplicate heading slug count feeds later heading ids");
  md.setMathAutoNumber(true);
  check(sigOf(base, 7) !== sigOf(edit(1, "See [the docs][ref]"), 7), "Removing an earlier equation renumbers later ones");
  md.setMathAutoNumber(false);
  check(sigOf(base, 8) !== sigOf(edit(7, "$$b \\label{eq:c}$$"), 8), "Equation label change re-renders \\eqref users");
  check(sigOf(base, 9, "/a/doc.md") !== sigOf(base, 9, "/b/doc.md"), "Image blocks re-resolve when the document moves");
  check(sigOf(base, 2, "/a/doc.md") === sigOf(base, 2, "/b/doc.md"), "Blocks without images ignore the document path");
  check(sigOf(["---\nimage-root-url: /a\n---", "![p](/x.png)"], 1) !== sigOf(["---\nimage-root-url: /b\n---", "![p](/x.png)"], 1), "Image blocks re-resolve when image-root-url changes");
  const toc = ["[TOC]", "# One"];
  check(sigOf(toc, 0) !== sigOf(["[TOC]", "# Two"], 0), "TOC re-renders when headings change");
  const blocks = base.map((text, id) => ({ id, text }));
  md.setMarkdownDocumentProvider(() => blocks);
  check(md.renderMarkdown(blocks[8].text, "8").includes("(1)"), "Keyed render reads equation labels from the document");
  md.setMarkdownDocumentProvider(() => []);

  // A context reused after an edit (see reuseContext) must equal one built
  // from scratch for the edited document.
  const plain = (ctx) => JSON.stringify(ctx, (_k, v) => v instanceof Map ? [...v] : v instanceof Set ? [...v] : v);
  const doc = [...base, "    continued footnote", "Last plain paragraph"];
  const build = (texts) => md.buildRenderContext(texts.map((text, id) => ({ id, text })));
  const fresh = (texts) => { build(["reset"]); return build(texts); };
  for (const [i, text] of [
    [2, "Plain words, edited"], [2, "Now with a [link][ref]"], [2, "Now a footnote[^n]"], [0, "# Renamed"],
    [0, "---\ntitle: x\n---"], [3, "[ref]: https://b.example"], [5, "[^n]: Changed"], [10, "    edited continuation"],
    [7, "$$c \\label{eq:b}$$"], [11, "## Now a heading"], [11, "Last plain paragraph, longer"],
  ]) {
    build(doc);
    const edited = doc.map((t, j) => j === i ? text : t);
    equal(plain(build(edited)), plain(fresh(edited)), `Reused context matches a fresh build after editing block ${i} to ${JSON.stringify(text)}`);
  }
  build(doc);
  check(build(doc.map((t, j) => j === 2 ? "Other plain words" : t)) === build(doc.map((t, j) => j === 2 ? "Third plain words" : t)), "Typing in a plain paragraph reuses the context");
}
{
  const source = "# Title\n\nSome *words* here, and [a link](x).\n\n```js\nconst ignored = 1;\n```\n\n- one\n- two three\n\n> quoted words";
  const texts = md.splitBlocks(source);
  equal(md.countBlockWords(texts), md.countWords(md.joinBlocks(texts)), "Counting block by block matches counting the whole document");
}
// Lexing a long document in pieces (lexDocument) must give exactly the tokens
// lexing it whole does. A tiny piece size cuts at nearly every legal point.
{
  const { readFileSync, readdirSync, statSync } = await import("node:fs");
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name.startsWith(".") || name === "node_modules" || name === "target") continue;
      const path = `${dir}/${name}`;
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".md")) files.push(path);
    }
  };
  walk(root.replace(/\/$/, ""));
  const tricky = [
    "Para one\n\n- loose item\n\n- next item\n\n  continued\n\nAfter list",
    "```js\nconst a = 1;\n\n\nconst b = 2;\n```\n\nText",
    "~~~~\n```\n\nstill code\n~~~~\n\nOut",
    "$$\na\n\nb\n$$\n\nText $$x$$ inline\n\nMore",
    "<!-- note\n\nstill comment -->\n\nText",
    "<pre>\nline\n\nline\n</pre>\n\nText",
    "Note[^n]\n\n[^n]: First\n\n    Continued\n\nAfter",
    "> quote\n\n> again\n\nText",
    "1. one\n\n2. two\n\n10) ten\n\nText",
    "Title\n=====\n\nSub\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |",
    "See [ref] and [other][o].\n\n# Heading\n\n[ref]: https://a.example\n\n[o]: https://b.example \"T\"",
    "    indented code\n\n    more code\n\nText\n\n<details>\n<summary>S</summary>\n\nBody\n\n</details>\n\nEnd",
  ].join("\n\n");
  const docs = [["tricky constructs", tricky], ...files.map((f) => [f.slice(root.length), readFileSync(f, "utf8")])];
  for (const [name, text] of docs) {
    const whole = md.lexDocument(text, undefined, Infinity);
    const pieces = md.lexDocument(text, undefined, 16);
    equal(JSON.stringify([pieces, pieces.links]), JSON.stringify([whole, whole.links]), `Lexing ${name} in pieces matches lexing it whole`);
  }
  check(md.documentPieces(tricky, 16).length > 5, "A document is cut into pieces");
  check(md.documentPieces("```\na\n\nb\n\nc\n```", 1).length === 1, "A fence is never cut");
}
console.log(`${checks} Markdown regression checks passed`);
