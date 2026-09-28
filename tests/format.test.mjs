/**
 * Tests for src/inlineformat.ts and src/blocktype.ts — the pure Markdown
 * analysis behind the selection toolbar. Bundled with esbuild and run in node;
 * neither module touches the DOM.
 *
 *   node tests/format.test.mjs   (part of `pnpm test`)
 *
 * The load-bearing property: a toggle must be its own inverse, and the
 * selection it reports back must still cover the same words — the toolbar
 * stays anchored across a run of clicks only if that holds.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, ".build");

await build({
  entryPoints: [
    path.join(here, "..", "src", "inlineformat.ts"),
    path.join(here, "..", "src", "blocktype.ts"),
    path.join(here, "..", "src", "tabletools.ts"),
    path.join(here, "..", "src", "slashmenu.ts"),
    path.join(here, "..", "src", "menuicons.ts"),
    path.join(here, "..", "src", "imageattrs.ts"),
    path.join(here, "..", "src", "links.ts"),
    path.join(here, "..", "src", "base16.ts"),
  ],
  bundle: true,
  format: "esm",
  outdir,
  outExtension: { ".js": ".mjs" },
});

const { activeMarks, toggleMark, scanMarks } = await import(path.join(outdir, "inlineformat.mjs"));
const { blockKind, applyBlockKind } = await import(path.join(outdir, "blocktype.mjs"));
const { appendTableRow, appendTableColumn, parseTable, cellRanges, parseTableDimension, skeletonTable } = await import(
  path.join(outdir, "tabletools.mjs")
);
const { SLASH_ITEMS, filterSlashItems, slashTriggerAt } = await import(
  path.join(outdir, "slashmenu.mjs")
);
const { ICONS } = await import(path.join(outdir, "menuicons.mjs"));
const { parseImgAttrs, buildImgTag, imageMarkup, needsHtmlSyntax, IMG_FIELDS } = await import(
  path.join(outdir, "imageattrs.mjs")
);
const { findLinks, linkForHref, linkMarkup, linkDestination } = await import(path.join(outdir, "links.mjs"));
const {
  BASE16_SLOTS, BASE16_ROLES, parseBase16, base16ToTokens, base16ToCss,
  toBase16Yaml, mixHex, luminance, normHex, isHex, DEFAULT_SCHEME,
} = await import(path.join(outdir, "base16.mjs"));

let failures = 0;
let passes = 0;
function assert(cond, label) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error("FAIL:", label);
  }
}
function eq(actual, expected, label) {
  assert(
    actual === expected,
    `${label}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`,
  );
}

/** Offsets of `sel` inside `text` (first occurrence). */
function at(text, sel) {
  const start = text.indexOf(sel);
  if (start < 0) throw new Error(`"${sel}" not in "${text}"`);
  return { start, end: start + sel.length };
}
const active = (text, sel) => {
  const { start, end } = at(text, sel);
  return [...activeMarks(text, start, end)].sort();
};

/* ---------- active-mark detection ---------- */

eq(active("**bold** here", "bold").join(), "strong", "bold detected");
eq(active("__bold__ here", "bold").join(), "strong", "underscore bold detected");
eq(active("*it* here", "it").join(), "emphasis", "italic detected");
eq(active("~~gone~~", "gone").join(), "strike", "strike detected");
eq(active("==hi==", "hi").join(), "highlight", "highlight detected");
eq(active("`x = 1`", "x = 1").join(), "code", "code span detected");
eq(active("<u>ul</u>", "ul").join(), "underline", "underline detected");
eq(active("H~2~O", "2").join(), "sub", "subscript detected");
eq(active("x^2^ + 1", "2").join(), "sup", "superscript detected");
eq(active("$a+b$ done", "a+b").join(), "math", "inline math detected");
eq(active("[label](http://x)", "label").join(), "link", "link label detected");

eq(active("plain words", "words").join(), "", "plain text has no marks");
eq(active("**bold** here", "here").join(), "", "text outside the pair is unmarked");
eq(
  active("**bold** here", "**bold**").join(),
  "",
  "a selection including the markers is not inside them",
);

// Nesting: the recursion into non-opaque spans is what makes this work.
eq(active("**a *b* c**", "b").join(), "emphasis,strong", "italic inside bold reports both");
eq(active("**a *b* c**", "a ").join(), "strong", "unnested part of bold reports only bold");
eq(
  active("[**x**](u)", "x").join(),
  "link,strong",
  "bold inside a link label reports both",
);

// Priority: earlier matchers claim their span, so `*` inside code or a URL is
// never read as emphasis — mirroring how livesource.ts styles the block.
eq(active("`a *b* c`", "*b*").join(), "code", "asterisks inside a code span stay literal");
eq(active("![alt](a_b_c.png)", "alt").join(), "image", "image alt is not a link label");
assert(
  !scanMarks("[x](http://a.com/_p_/q)").some((s) => s.kind === "emphasis"),
  "underscores in a link URL are not emphasis",
);
eq(active("**bold**", "bold").join(), "strong", "double asterisk beats single");

// Per-line scanning: markers never pair across a newline, matching livesource.
eq(active("*not\nclosed*", "not").join(), "", "emphasis does not span a newline");
eq(
  active("a\n**b**", "b").join(),
  "strong",
  "marks on the second line are found at the right offset",
);

// Fenced code is literal.
eq(active("```\n**x**\n```", "x").join(), "", "fenced code has no inline marks");

/* ---------- toggling on ---------- */

{
  const text = "make bold now";
  const { start, end } = at(text, "bold");
  const r = toggleMark(text, start, end, "strong");
  eq(r.text, "make **bold** now", "wraps the selection");
  eq(r.text.slice(r.start, r.end), "bold", "selection still covers the same word");
}
{
  const text = "link me";
  const { start, end } = at(text, "link");
  const r = toggleMark(text, start, end, "link");
  eq(r.text, "[link](url) me", "link wraps with a url placeholder");
  eq(r.text.slice(r.start, r.end), "url", "the placeholder is selected for typing over");
}

/* ---------- toggling off ---------- */

{
  const text = "make **bold** now";
  const { start, end } = at(text, "bold");
  const r = toggleMark(text, start, end, "strong");
  eq(r.text, "make bold now", "unwraps when already marked");
  eq(r.text.slice(r.start, r.end), "bold", "selection survives the unwrap");
}
{
  // Innermost wins: unbolding the inner run must not eat the outer emphasis.
  const text = "*a **b** c*";
  const { start, end } = at(text, "b");
  const r = toggleMark(text, start, end, "strong");
  eq(r.text, "*a b c*", "unwraps only the strong pair");
  eq(r.text.slice(r.start, r.end), "b", "selection survives a nested unwrap");
}
{
  const text = "<u>u</u>";
  const r = toggleMark(text, 3, 4, "underline");
  eq(r.text, "u", "multi-character markers unwrap fully");
  eq(r.text.slice(r.start, r.end), "u", "selection survives an html-marker unwrap");
}

/* ---------- round trips ---------- */

for (const kind of ["strong", "emphasis", "underline", "code", "strike", "highlight", "sup"]) {
  const text = "a word b";
  const { start, end } = at(text, "word");
  const on = toggleMark(text, start, end, kind);
  const off = toggleMark(on.text, on.start, on.end, kind);
  eq(off.text, text, `${kind}: toggling twice restores the source`);
  eq(off.text.slice(off.start, off.end), "word", `${kind}: selection survives a round trip`);
  assert([...activeMarks(on.text, on.start, on.end)].includes(kind), `${kind}: reads back as active`);
}

/* ---------- block kinds ---------- */

eq(blockKind("plain"), "paragraph", "paragraph detected");
eq(blockKind("## Title"), "h2", "heading level detected");
eq(blockKind("###### Deep"), "h6", "h6 detected");
eq(blockKind("> quoted"), "quote", "quote detected");
eq(blockKind("- item"), "bullet", "bullet detected");
eq(blockKind("3. item"), "ordered", "ordered detected");
eq(blockKind("- [ ] todo"), "task", "task detected (before bullet)");
eq(blockKind("- [x] done"), "task", "checked task detected");
eq(blockKind("```js\ncode\n```"), "code", "fence detected");
eq(blockKind("#hashtag"), "paragraph", "a hash without a space is not a heading");

/* ---------- block conversion ---------- */

const conv = (text, kind) => applyBlockKind(text, kind).text;

eq(conv("plain", "h1"), "# plain", "paragraph to heading");
eq(conv("# Title", "paragraph"), "Title", "heading to paragraph");
eq(conv("# Title", "h3"), "### Title", "heading level change");
eq(conv("- item", "h1"), "# item", "list to heading strips the marker");
eq(conv("- a\n- b", "ordered"), "1. a\n2. b", "bullet to ordered renumbers");
eq(conv("1. a\n2. b", "bullet"), "- a\n- b", "ordered to bullet");
eq(conv("- a\n- b", "task"), "- [ ] a\n- [ ] b", "bullet to task");
eq(conv("- [x] a", "bullet"), "- a", "task to bullet drops the checkbox");
eq(conv("> quoted", "paragraph"), "quoted", "quote to paragraph");
eq(conv("> # Title", "paragraph"), "Title", "nested quote+heading unwraps");
eq(conv("a\nb", "code"), "```\na\nb\n```", "paragraph to code block");
eq(conv("```js\na\nb\n```", "paragraph"), "a\nb", "code block to paragraph");
eq(conv("  - indented", "paragraph"), "indented", "indent is stripped with the marker");
eq(conv("a\n\nb", "bullet"), "- a\n\n- b", "blank lines stay blank");
// ...but a wholly empty block still takes the prefix — the slash menu converts
// an otherwise blank line, and returning it unchanged made `/h2` a no-op.
eq(conv("", "h2"), "## ", "an empty block converts to a heading");
eq(conv("", "bullet"), "- ", "an empty block converts to a bullet");
eq(conv("", "task"), "- [ ] ", "an empty block converts to a task");
eq(conv("", "quote"), "> ", "an empty block converts to a quote");
eq(conv("", "paragraph"), "", "an empty block stays empty as a paragraph");

/* ---------- block conversion offset mapping ---------- */

{
  const text = "- alpha\n- beta";
  const edit = applyBlockKind(text, "ordered");
  eq(edit.text, "1. alpha\n2. beta", "sanity: renumbered");
  const sel = at(text, "beta");
  eq(
    edit.text.slice(edit.map(sel.start), edit.map(sel.end)),
    "beta",
    "selection on the second line maps through a prefix change",
  );
}
{
  const text = "# Title";
  const edit = applyBlockKind(text, "paragraph");
  const sel = at(text, "Title");
  eq(
    edit.text.slice(edit.map(sel.start), edit.map(sel.end)),
    "Title",
    "selection maps through a prefix removal",
  );
}
{
  const text = "plain";
  const edit = applyBlockKind(text, "quote");
  const sel = at(text, "plain");
  eq(
    edit.text.slice(edit.map(sel.start), edit.map(sel.end)),
    "plain",
    "selection maps through a prefix addition",
  );
}
{
  const text = "```\nbody\n```";
  const edit = applyBlockKind(text, "paragraph");
  const sel = at(text, "body");
  eq(
    edit.text.slice(edit.map(sel.start), edit.map(sel.end)),
    "body",
    "selection maps through an unfence",
  );
}
{
  const text = "body";
  const edit = applyBlockKind(text, "code");
  const sel = at(text, "body");
  eq(
    edit.text.slice(edit.map(sel.start), edit.map(sel.end)),
    "body",
    "selection maps through a fence wrap",
  );
}

/* ---------- table edge append (the "+" rails) ---------- */

const TABLE = "| a | b |\n| --- | --- |\n| 1 | 2 |";

{
  const r = appendTableRow(TABLE);
  const t = parseTable(r.text);
  eq(t.rows.length, 3, "append row: one more row");
  eq(t.align.length, 2, "append row: column count unchanged");
  eq(t.rows[2].join("|").trim(), "|", "append row: the new row is empty");
  eq(t.rows[0].join(","), "a,b", "append row: header survives");
  eq(t.rows[1].join(","), "1,2", "append row: existing body survives");
  // The caret target must resolve to a real cell in the NEW source.
  const cell = cellRanges(r.text)[r.cell];
  assert(!!cell, "append row: reported cell index resolves");
  eq(
    r.text.slice(0, cell.start).split("\n").length - 1,
    3,
    "append row: caret lands on the new last line",
  );
}
{
  const r = appendTableColumn(TABLE);
  const t = parseTable(r.text);
  eq(t.align.length, 3, "append column: one more column");
  eq(t.rows.length, 2, "append column: row count unchanged");
  eq(t.rows[0][2].trim(), "", "append column: new header cell is empty");
  eq(t.rows[1].join(","), "1,2,", "append column: body row gains an empty cell");
  const cell = cellRanges(r.text)[r.cell];
  assert(!!cell, "append column: reported cell index resolves");
  eq(
    r.text.slice(0, cell.start).split("\n").length - 1,
    0,
    "append column: caret lands in the header row",
  );
  // Index 2 is the third header cell — i.e. the column just added.
  eq(r.cell, 2, "append column: caret targets the new column");
}
{
  // Alignment must ride along, so appending never silently reformats.
  const aligned = "| a | b |\n| :-- | --: |\n| 1 | 2 |";
  eq(parseTable(appendTableRow(aligned).text).align.join(), "left,right",
    "append row preserves column alignment");
  eq(parseTable(appendTableColumn(aligned).text).align.join(), "left,right,",
    "append column preserves existing alignment and adds a default");
}
eq(appendTableRow("not a table"), null, "append row on a non-table returns null");
eq(appendTableColumn("not a table"), null, "append column on a non-table returns null");
{
  // resizeTable caps at 16 columns; the rail must not build a table it can't edit.
  const wide = "|" + " a |".repeat(16) + "\n|" + " --- |".repeat(16);
  eq(parseTable(wide).align.length, 16, "sanity: 16-column table parsed");
  eq(appendTableColumn(wide), null, "append column stops at the 16-column cap");
}

/* ---------- slash trigger detection ---------- */

const trig = (text, caret = text.length) => slashTriggerAt(text, caret);

eq(JSON.stringify(trig("/")), '{"start":0,"query":""}', "bare slash at start triggers");
eq(JSON.stringify(trig("/head")), '{"start":0,"query":"head"}', "slash query captured");
eq(JSON.stringify(trig("some text /ta")), '{"start":10,"query":"ta"}', "slash after a space triggers");
eq(JSON.stringify(trig("> /note")), '{"start":2,"query":"note"}', "slash inside a quote prefix triggers");
eq(trig("- item\n/h1").query, "h1", "slash at the start of a later line triggers");

// The guards that keep paths and URLs from opening the menu.
eq(trig("src/foo"), null, "a path segment does not trigger");
eq(trig("https://x.com/p"), null, "a URL does not trigger");
eq(trig("a/b"), null, "slash between words does not trigger");
eq(trig("//"), null, "a doubled slash does not trigger");
eq(trig("/head "), null, "a space after the query dismisses");
eq(trig("/a b"), null, "the query stops at whitespace");
eq(trig("plain text"), null, "no slash, no trigger");

// The trigger is measured to the caret, not the end of the text.
eq(JSON.stringify(trig("/ta ble", 3)), '{"start":0,"query":"ta"}', "trigger respects caret position");
{
  const t = trig("/head", 3);
  eq(t.query, "he", "query is truncated at the caret");
  eq("/head".slice(t.start, 3), "/he", "start..caret spans exactly the trigger text");
}

/* ---------- slash item filtering ---------- */

const labels = (q) => filterSlashItems(q).map((i) => i.label);

assert(filterSlashItems("").length === SLASH_ITEMS.length, "empty query returns everything");
eq(filterSlashItems("").join === SLASH_ITEMS.join, true, "empty query keeps catalogue order");
eq(labels("head")[0], "Heading 1", "label prefix ranks first");
eq(labels("h2")[0], "Heading 2", "alias finds the right heading");
eq(labels("todo")[0], "Task List", "alias finds task list");
eq(labels("ul")[0], "Bullet List", "ul alias");
eq(labels("ol")[0], "Ordered List", "ol alias");
eq(labels("table")[0], "Table", "exact label wins over 'Table of Contents'");
eq(labels("quote")[0], "Quote", "quote");
eq(labels("mermaid")[0], "Mermaid Diagram", "mermaid");
eq(labels("d2")[0], "D2 Diagram", "d2");
// Label prefix must outrank a mere alias hit: several callouts alias "callout".
eq(labels("co")[0], "Code Block", "label prefix outranks alias-only matches");
eq(labels("zzzz").length, 0, "no matches returns empty");
assert(labels("callout").includes("Note"), "alias substring still matches");
assert(labels("").includes("Important"), "the full GitHub alert set is offered");
assert(labels("").includes("Caution"), "caution is offered");
// Every item must point at an icon that actually exists.
for (const item of SLASH_ITEMS) {
  assert(!!ICONS[item.icon], `item "${item.label}" has a real icon (${item.icon})`);
}

/* ---------- image attributes ---------- */

{
  const a = parseImgAttrs('<img src="a.png" alt="An image" width="820" loading="eager" />');
  eq(a.src, "a.png", "parse src");
  eq(a.alt, "An image", "parse alt with spaces");
  eq(a.width, "820", "parse width");
  eq(a.loading, "eager", "parse enum attr");
  eq(Object.keys(a).length, 4, "no phantom attributes");
}
eq(parseImgAttrs("<img src='x.png'>").src, "x.png", "single-quoted values parse");
eq(parseImgAttrs("<img src=x.png>").src, "x.png", "unquoted values parse");
eq(parseImgAttrs('<img SRC="x.png">').src, "x.png", "attribute names are lowercased");
eq(parseImgAttrs('<img src="x.png" hidden>').hidden, "", "valueless attributes parse");

// Values arrive as HTML, so entities have to be decoded on the way in —
// otherwise buildImgTag escapes them a second time and every rewrite adds
// another "amp;".
eq(parseImgAttrs('<img alt="Tom &amp; Jerry">').alt, "Tom & Jerry", "named entities decode");
eq(parseImgAttrs('<img alt="&lt;b&gt; &quot;q&quot; &apos;a&apos;">').alt, `<b> "q" 'a'`, "the rest of the escape set decodes");
eq(parseImgAttrs('<img src="a.png?w=1&amp;h=2">').src, "a.png?w=1&h=2", "a query string keeps its real ampersand");
eq(parseImgAttrs('<img alt="caf&#233; &#x2014; open">').alt, "café — open", "numeric and hex references decode");
eq(parseImgAttrs('<img alt="&amp;lt; stays text">').alt, "&lt; stays text", "decoding is a single pass");
eq(parseImgAttrs('<img alt="100&percnt; &bogus; &#xZZ;">').alt, "100&percnt; &bogus; &#xZZ;", "unknown or malformed references are left alone");

// src/alt are always emitted; unset optional attributes are omitted entirely.
eq(buildImgTag({ src: "a.png", alt: "" }), '<img src="a.png" alt="" />', "minimal tag");
eq(
  buildImgTag({ src: "a.png", alt: "x", width: "820", loading: "eager" }),
  '<img src="a.png" alt="x" width="820" loading="eager" />',
  "attributes follow schema order, not insertion order",
);
eq(
  buildImgTag({ loading: "eager", width: "820", alt: "x", src: "a.png" }),
  '<img src="a.png" alt="x" width="820" loading="eager" />',
  "output is stable regardless of key order",
);
eq(buildImgTag({ src: "a.png", alt: "x", width: "" }), '<img src="a.png" alt="x" />', "empty values are dropped");
eq(
  buildImgTag({ src: "a.png", alt: "x", "data-id": "7", class: "hero" }),
  '<img src="a.png" alt="x" data-id="7" class="hero" />',
  "unknown attributes are preserved",
);
eq(buildImgTag({ src: 'a".png', alt: "<b>" }), '<img src="a&quot;.png" alt="&lt;b&gt;" />', "values are escaped");

eq(needsHtmlSyntax({ src: "a", alt: "b" }), false, "src+alt alone fit markdown");
eq(needsHtmlSyntax({ src: "a", alt: "b", width: "" }), false, "an empty extra still fits markdown");
eq(needsHtmlSyntax({ src: "a", width: "820" }), true, "width forces html");
eq(needsHtmlSyntax({ style: "zoom: 50%" }), true, "style forces html");

/* ---------- markdown <-> html promotion ---------- */

eq(imageMarkup("a.png", "x", "md"), "![x](a.png)", "plain image stays markdown");
eq(imageMarkup("a.png", "", "md"), "![](a.png)", "empty alt stays markdown");
eq(
  imageMarkup("a.png", "x", "md", { width: "820" }),
  '<img src="a.png" alt="x" width="820" />',
  "setting width promotes markdown to an img tag",
);
eq(
  imageMarkup("a.png", "x", "md", { width: "" }),
  "![x](a.png)",
  "an empty width does not promote",
);
eq(
  imageMarkup("a.png", "x", "html"),
  '<img src="a.png" alt="x" />',
  "an explicit html image stays html with no extras",
);
// The bug this fixes: rewriting an image used to emit only src/alt/style,
// silently discarding width/loading/etc.
{
  const tag = '<img src="a.png" alt="old" width="820" loading="lazy" data-x="1" />';
  const attrs = parseImgAttrs(tag);
  eq(
    imageMarkup("a.png", "new", "html", attrs),
    '<img src="a.png" alt="new" width="820" loading="lazy" data-x="1" />',
    "editing alt preserves every other attribute",
  );
}
{
  // Round trip: parse -> build -> parse is stable.
  const tag = '<img src="a.png" alt="x" width="820" height="400" title="t" srcset="a-2x.png 2x" sizes="50vw" loading="eager" decoding="sync" fetchpriority="high" crossorigin="anonymous" referrerpolicy="no-referrer" />';
  const once = buildImgTag(parseImgAttrs(tag));
  eq(buildImgTag(parseImgAttrs(once)), once, "parse/build round-trips");
  const back = parseImgAttrs(once);
  for (const f of IMG_FIELDS) {
    assert(back[f.name] !== undefined, `round trip keeps ${f.name}`);
  }
}
{
  // The reported bug: an entity in the source used to gain an extra "amp;" on
  // every rewrite, so an alt drifted further from the original with each edit.
  const tag = '<img src="a.png?w=1&amp;h=2" alt="Tom &amp; Jerry" title="5 &lt; 6" />';
  const once = buildImgTag(parseImgAttrs(tag));
  eq(once, tag, "a tag with entities rebuilds byte-identically");
  eq(buildImgTag(parseImgAttrs(once)), once, "…and a second pass adds nothing");
  eq(
    imageMarkup("a.png", "Tom & Jerry", "md"),
    "![Tom & Jerry](a.png)",
    "demoting to markdown writes the decoded text, not the entity",
  );
}
// Every enum field offers "not set" as its first option.
for (const f of IMG_FIELDS.filter((x) => x.kind === "enum")) {
  eq(f.options[0], "", `${f.name} can be cleared`);
}

/* ---------- base16 colour utilities ---------- */

eq(normHex("#AABBCC"), "#aabbcc", "hex is normalised to lowercase");
eq(normHex("aabbcc"), "#aabbcc", "bare hex gains its #");
eq(isHex("#282a36"), true, "valid hex accepted");
eq(isHex("#28a"), false, "short hex rejected");
eq(isHex("nope"), false, "non-hex rejected");
eq(mixHex("#000000", "#ffffff", 0), "#000000", "mix at 0 is the first colour");
eq(mixHex("#000000", "#ffffff", 1), "#ffffff", "mix at 1 is the second colour");
eq(mixHex("#000000", "#ffffff", 0.5), "#808080", "mix at 0.5 is the midpoint");
assert(luminance("#ffffff") > luminance("#000000"), "white is more luminous than black");

/* ---------- base16 parsing ---------- */

// Tinted Theming layout: nested palette, #-prefixed, explicit variant.
const TINTED = `system: base16
name: "Dracula"
author: "Mike Barkmin"
variant: dark
palette:
  base00: "#282a36"
  base01: "#363447"
  base02: "#44475a"
  base03: "#6272a4"
  base04: "#9ea8c7"
  base05: "#f8f8f2"
  base06: "#f0f1f4"
  base07: "#ffffff"
  base08: "#ff5555"
  base09: "#ffb86c"
  base0A: "#f1fa8c"
  base0B: "#50fa7b"
  base0C: "#8be9fd"
  base0D: "#80bfff"
  base0E: "#ff79c6"
  base0F: "#bd93f9"
`;
{
  const { scheme, error } = parseBase16(TINTED);
  eq(error, undefined, "tinted-theming layout parses");
  eq(scheme.name, "Dracula", "name is read");
  eq(scheme.author, "Mike Barkmin", "author is read");
  eq(scheme.variant, "dark", "declared variant is used");
  eq(scheme.palette.base00, "#282a36", "slot value parsed");
  eq(scheme.palette.base0F, "#bd93f9", "last slot parsed");
  eq(Object.keys(scheme.palette).length, 16, "all sixteen slots present");
}

// Original chriskempson layout: flat keys, bare hex, no variant.
const FLAT = `scheme: "Ocean"
author: "Chris Kempson"
base00: 2b303b
base01: 343d46
base02: 4f5b66
base03: 65737e
base04: a7adba
base05: c0c5ce
base06: dfe1e8
base07: eff1f5
base08: bf616a
base09: d08770
base0A: ebcb8b
base0B: a3be8c
base0C: 96b5b4
base0D: 8fa1b3
base0E: b48ead
base0F: ab7967
`;
{
  const { scheme, error } = parseBase16(FLAT);
  eq(error, undefined, "chriskempson layout parses");
  eq(scheme.name, "Ocean", "`scheme:` is accepted as the name");
  eq(scheme.palette.base00, "#2b303b", "bare hex gains its #");
  // No `variant:` in this layout — it has to be inferred from the ramp.
  eq(scheme.variant, "dark", "variant inferred as dark when base00 is darker than base05");
}
{
  // A light scheme must infer the other way.
  const light = FLAT.replace("base00: 2b303b", "base00: eff1f5").replace("base05: c0c5ce", "base05: 2b303b");
  eq(parseBase16(light).scheme.variant, "light", "variant inferred as light when base00 is lighter");
}
{
  // JSON is the same key/value shape, so it falls out of the same scan.
  const json = JSON.stringify({ name: "J", variant: "dark", palette: JSON.parse(
    "{" + BASE16_SLOTS.map((s, i) => `"${s}":"#${String(i).padStart(2, "0")}0000"`).join(",") + "}") });
  const { scheme, error } = parseBase16(json);
  eq(error, undefined, "JSON scheme parses");
  eq(scheme.palette.base00, "#000000", "JSON slot parsed");
}

// Error paths.
assert(parseBase16("").error, "empty input reports an error");
assert(parseBase16("hello world").error?.includes("No base16 colours"), "junk input is rejected");
{
  const partial = TINTED.replace('  base0F: "#bd93f9"\n', "");
  const { error } = parseBase16(partial);
  assert(error?.includes("base0F"), `a missing slot is named in the error (${error})`);
}

/* ---------- derivation ---------- */

const dracula = parseBase16(TINTED).scheme;
{
  const t = base16ToTokens(dracula);
  eq(t["--bg-page"], "#282a36", "page surface is base00");
  eq(t["--bg-panel"], "#363447", "panel surface is base01");
  eq(t["--ink"], "#f8f8f2", "body text is base05");
  eq(t["--ink-soft"], "#9ea8c7", "secondary text is base04");
  eq(t["--rule"], "#44475a", "borders are base02");
  eq(t["--accent"], "#80bfff", "accent is base0D");
  eq(t["--link"], "#8be9fd", "link is base0C");
  assert(t["--accent"] !== t["--link"], "accent and link stay distinct");
  eq(t["--mermaid-theme"], "dark", "dark scheme selects the dark mermaid theme");
  eq(t["--warn"], "#ff5555", "warn is base08");

  // Sarala layers six surfaces where base16 offers three; the in-between tones
  // must be genuinely between, not collapsed onto a neighbour.
  assert(t["--bg"] !== t["--bg-page"] && t["--bg"] !== t["--bg-panel"],
    "--bg is mixed, not collapsed onto base00/base01");
  assert(t["--tint"] !== t["--bg-panel"], "--tint is distinct from the panel it sits on");
  assert(t["--rule-soft"] !== t["--rule"], "--rule-soft is quieter than --rule");

  // Every token a curated theme defines must be produced, or the custom theme
  // would inherit stray values from whichever theme was active before.
  for (const key of [
    "--bg", "--bg-panel", "--bg-page", "--bg-topbar", "--chip", "--track", "--tint",
    "--ink", "--ink-soft", "--accent", "--accent-soft", "--select", "--select-soft",
    "--rule", "--rule-soft", "--rail", "--grip", "--code-bg", "--code-border",
    "--code-ink", "--quote-bar", "--link", "--marker", "--marker-opacity",
    "--shadow", "--mermaid-theme",
  ]) {
    assert(t[key] !== undefined, `derivation produces ${key}`);
  }
}
{
  // Light schemes must not keep the dark shadow/mermaid choices.
  const light = { ...dracula, variant: "light" };
  const t = base16ToTokens(light);
  eq(t["--mermaid-theme"], "default", "light scheme selects the light mermaid theme");
  assert(t["--shadow"] !== base16ToTokens(dracula)["--shadow"], "shadow differs by variant");
}

/* ---------- css + round trip ---------- */
{
  const css = base16ToCss(dracula);
  // A bare attribute rule, matching the curated blocks' shape — so the tokens
  // also cascade into a nested preview card carrying data-theme="custom".
  assert(css.startsWith('[data-theme="custom"] {'), "css targets the custom theme slot");
  assert(!css.startsWith(".app"), "selector is not scoped to .app, so previews inherit it");
  assert(css.includes("--bg-page: #282a36;"), "css carries derived values");
  assert(css.trimEnd().endsWith("}"), "css block is closed");
  assert(css.includes('[data-theme="custom"] .shiki span { color: var(--shiki-dark) !important; }'), "a dark scheme switches code to Shiki's dark palette");
}
{
  const round = parseBase16(toBase16Yaml(dracula)).scheme;
  eq(round.name, dracula.name, "yaml round trip keeps the name");
  eq(round.variant, dracula.variant, "yaml round trip keeps the variant");
  for (const slot of BASE16_SLOTS) {
    eq(round.palette[slot], dracula.palette[slot], `yaml round trip keeps ${slot}`);
  }
}
// The bundled starting scheme must itself be valid.
eq(Object.keys(DEFAULT_SCHEME.palette).length, 16, "default scheme has sixteen slots");
for (const slot of BASE16_SLOTS) {
  assert(isHex(DEFAULT_SCHEME.palette[slot]), `default scheme slot ${slot} is valid hex`);
  assert(!!BASE16_ROLES[slot], `slot ${slot} has a role label for the editor`);
}

/* ---------- links ---------- */

{
  const t = "See [Shiki](https://shiki.style) for details.";
  const [l] = findLinks(t);
  eq(l.kind, "md", "markdown link detected");
  eq(l.label, "Shiki", "label parsed");
  eq(l.url, "https://shiki.style", "url parsed");
  eq(t.slice(l.start, l.end), "[Shiki](https://shiki.style)", "span covers the whole occurrence");
}
{
  const t = "Read https://example.com today.";
  const [l] = findLinks(t);
  eq(l.kind, "bare", "bare URL detected");
  eq(l.url, "https://example.com", "bare url parsed");
  eq(l.label, l.url, "a bare URL is its own label");
}
// An image shares the bracket syntax but is not a link — and its URL must not
// then surface as a bare one.
eq(findLinks("![alt](https://x.com/a.png)").length, 0, "images are not links");
eq(findLinks("![a](https://x.com/i.png) and [b](https://y.com)").length, 1, "only the real link is reported");
// A URL inside a markdown link is already covered by it.
eq(findLinks("[x](https://one.com)").length, 1, "a link's own url is not double-counted");
eq(findLinks("[x](https://one.com) plus https://two.com").length, 2, "…but a separate bare url still counts");
// Angle-bracket destinations.
eq(findLinks("[x](<https://a.com/b c>)").at(0)?.url, "https://a.com/b c", "angle-bracket destination parsed");
// Titles are not part of the url.
eq(findLinks('[x](https://a.com "t")').at(0)?.url, "https://a.com", "a title is excluded from the url");
// Document order.
eq(
  findLinks("[a](https://1.com) [b](https://2.com)").map((l) => l.label).join(","),
  "a,b",
  "links come back in document order",
);

/* ---------- resolving a hovered anchor ---------- */
{
  // Repeated links to one URL must resolve to the right occurrence.
  const t = "[one](https://same.com) then [two](https://same.com)";
  eq(linkForHref(t, "https://same.com", 0).label, "one", "first occurrence of a repeated href");
  eq(linkForHref(t, "https://same.com", 1).label, "two", "second occurrence of a repeated href");
  eq(linkForHref(t, "https://absent.com", 0), null, "an href with no source link resolves to null");
}

/* ---------- rewrites ---------- */
eq(linkMarkup("Shiki", "https://new.dev", "md"), "[Shiki](https://new.dev)", "md link retargets");
// A bare URL is its own visible text, so keeping the bracket form would change
// what the reader sees.
eq(linkMarkup("https://old.com", "https://new.com", "bare"), "https://new.com", "bare link retargets to plain text");

/* ---------- where a link goes ---------- */

const DIR = "/home/me/notes";
const dest = (href) => linkDestination(href, DIR);

// The reported bug: a relative link to a sibling document was handed to the OS
// opener as a schemeless path, which has no idea what it is relative to.
eq(dest("RELEASING.md").kind, "document", "a sibling .md opens as a document");
eq(dest("RELEASING.md").path, "/home/me/notes/RELEASING.md", "…resolved against the document's folder");
eq(dest("docs/guide.markdown").path, "/home/me/notes/docs/guide.markdown", "nested relative path resolves");
eq(dest("../other/notes.txt").path, "/home/me/other/notes.txt", "parent traversal resolves");
eq(dest("./same.md").path, "/home/me/notes/same.md", "leading ./ is normalised away");

// Anything with a scheme belongs to the OS.
eq(dest("https://example.com").kind, "external", "http url is external");
eq(dest("mailto:a@b.com").kind, "external", "mailto is external");
eq(dest("file:///tmp/x.md").kind, "external", "an explicit file: url is left alone");

// In-document jumps.
eq(dest("#installing").kind, "anchor", "a fragment is an anchor");
eq(dest("#installing").id, "installing", "…with the id extracted");

// Local non-documents go to the desktop, not the editor.
eq(dest("diagram.png").kind, "file", "a local non-document is a file");
eq(dest("/etc/hosts").kind, "file", "an absolute path is a file");
eq(dest("/home/me/a.md").path, "/home/me/a.md", "an absolute document is not re-joined");

// A Windows drive letter looks like a URL scheme, so it has to be ruled out
// before the scheme test — otherwise every absolute path on Windows is thrown
// at the OS as a url and no local document ever opens.
eq(dest("C:\\docs\\README.md").kind, "document", "a drive-letter path is a local document");
eq(dest("C:\\docs\\README.md").path, "C:/docs/README.md", "…with backslashes normalised");
eq(dest("c:/docs/README.md").kind, "document", "a lowercase forward-slash drive path routes the same");
eq(dest("C:\\bin\\tool.exe").kind, "file", "a drive-letter non-document goes to the desktop");
eq(dest("C:\\docs\\README.md#signing").path, "C:/docs/README.md", "a fragment is stripped from a drive path");

// Fragments and queries must not leak into the filesystem path.
eq(dest("RELEASING.md#signing").path, "/home/me/notes/RELEASING.md", "a fragment is stripped from the path");
eq(dest("RELEASING.md#signing").kind, "document", "…and it still routes as a document");

// Nothing to do.
eq(dest("").kind, "unknown", "an empty href goes nowhere");
eq(linkDestination("RELEASING.md", null).kind, "unknown", "a relative link with no open folder cannot resolve");

// Dialog drafts stay editable; invalid values must never create a coerced table.
for (const draft of ["", " ", "0", "-1", "2.5", "NaN", "Infinity", "65"]) {
  eq(parseTableDimension(draft, 64), null, `invalid row draft: ${JSON.stringify(draft)}`);
}
for (const draft of ["17", "-2", "1.5", ""]) {
  eq(parseTableDimension(draft, 16), null, `invalid column draft: ${JSON.stringify(draft)}`);
}
eq(parseTableDimension("1", 64), 1, "minimum table dimension");
eq(parseTableDimension("64", 64), 64, "maximum body row count");
eq(parseTableDimension("16", 16), 16, "maximum column count");
const defaultTable = parseTable(skeletonTable(3, 2));
eq(defaultTable.rows.length, 4, "dialog body rows exclude header");
eq(defaultTable.rows[0].length, 2, "preview columns match generated table");
const maxTable = parseTable(skeletonTable(64, 16));
eq(maxTable.rows.length, 65, "maximum table preserves all requested body rows");
eq(maxTable.rows[0].length, 16, "maximum table preserves requested columns");

console.log(`${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
