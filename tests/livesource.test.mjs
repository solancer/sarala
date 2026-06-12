/**
 * Tests for src/livesource.ts: bundle with esbuild, run in node with jsdom.
 *
 *   pnpm test   (= node tests/livesource.test.mjs)
 *
 * The load-bearing invariant: a live-styled block's textContent must be
 * byte-identical to its markdown source — caret save/restore measures text
 * offsets across ALL text nodes, including CSS-hidden ones.
 */
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outfile = path.join(here, ".build", "livesource.mjs");

await build({
  entryPoints: [path.join(here, "..", "src", "livesource.ts")],
  bundle: true,
  format: "esm",
  outfile,
});

// DOM globals must exist before the module's functions run.
const dom = new JSDOM("<!doctype html><body></body>");
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Node = dom.window.Node;
globalThis.NodeFilter = dom.window.NodeFilter;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Text = dom.window.Text;

const { styleSource, applyMarkerVisibility } = await import(outfile);

let failures = 0;
let passes = 0;
function assert(cond, label) {
  if (cond) {
    passes++;
  } else {
    failures++;
    console.error(`FAIL: ${label}`);
  }
}

const host = () => dom.window.document.createElement("div");

/* ---------- textContent roundtrip ---------- */

const SAMPLES = [
  "plain paragraph",
  "# Heading",
  "###   spaced heading",
  "## Head with **bold** and `code`",
  "a **bold** and *ital* and ~~gone~~ and `span` mix",
  "link [label](https://example.com/x?y=1) here",
  "image ![alt text](./assets/pic.png) end",
  "**[link inside bold](u)** trailing",
  "- item one\n- item two **strong**\n- [ ] task",
  "1. first\n2. second",
  "> quoted *line*\n> more",
  "```rust\nfn main() { println!(\"**not bold**\"); }\n```",
  "---\ntitle: front matter\n---",
  "***",
  "text with <angle> & ampersand **bold**",
  "## Head\nbody line with [a](b)\nlast line",
  "**unpaired marker stays plain",
  "emoji ✨ **宽字符** test",
  "| Shortcut | Action |\n| --- | --- |\n| Cmd/Ctrl+S | Save **now** |",
  "| Column 1 | Column 2 |\n| --- | --- |\n|   |   |\n|   |   |",
  "intro line\n| a | b |\n| :-- | --: |\n| 1 | 2 |",
  "| not a table without separator |",
];

for (const src of SAMPLES) {
  const el = host();
  el.innerHTML = styleSource(src);
  assert(el.textContent === src, `roundtrip: ${JSON.stringify(src.slice(0, 40))}`);
  // Reveal toggling must never alter the text either.
  for (const caret of [0, Math.floor(src.length / 2), src.length]) {
    applyMarkerVisibility(el, src, caret);
    assert(el.textContent === src, `roundtrip after reveal@${caret}: ${JSON.stringify(src.slice(0, 40))}`);
  }
}

/* ---------- token wrappers present ---------- */

assert(styleSource("a **b** c").includes('class="md-tok"'), "styleSource emits md-tok");
assert(styleSource("# H").includes("md-tok md-pre"), "heading hashes wrapped in md-tok md-pre");
assert(styleSource("- item").includes("md-tok md-pre md-bullet"), "bullet marker wrapped");
assert(styleSource("- [ ] t").includes("md-task"), "task marker wrapped");
assert(styleSource("- [x] t").includes("md-task md-done"), "checked task marker flagged");
assert(styleSource("> q").includes("md-quote-pre"), "quote marker wrapped");
assert(!styleSource("1. x").includes("md-tok"), "ordered marker stays always-visible (no token)");

/* ---------- table structure ---------- */
{
  const src = "| a | b |\n| --- | --- |\n| 1 | **2** |";
  const html = styleSource(src);
  assert(html.includes('class="md-table"'), "table run wrapped in md-table");
  assert(html.includes("md-tsep"), "separator row flagged md-tsep");
  const el = host();
  el.innerHTML = html;
  assert(el.textContent === src, "table roundtrip");
  const pipes = el.querySelectorAll(".md-pipe").length;
  assert(pipes === (src.match(/\|/g) || []).length, `every pipe wrapped (${pipes})`);
  assert(el.querySelectorAll(".md-trow").length === 3, "three rows");
  assert(el.querySelectorAll(".md-trow:not(.md-tsep) .md-tcell").length === 4, "four content cells");
  assert(!!el.querySelector(".md-tcell .md-tok"), "inline tokens still work inside cells");
  // pipes are not caret-scoped tokens: reveal pass leaves them untouched
  applyMarkerVisibility(el, src, 3);
  assert(![...el.querySelectorAll(".md-pipe")].some((p) => p.classList.contains("md-on")),
    "pipes never gain md-on (always concealed by table layout)");
}

assert(!styleSource("| lone | row |").includes("md-table"),
  "a pipey line without a separator below is not a table");

/* ---------- fence concealment (zero-jank code blocks) ---------- */
// "```rust\ncode\n```" — fence tokens swallow their newlines: open [0, 8),
// close [13, 17); the code line sits between.
{
  const src = "```rust\nlet x;\n```";
  const el = host();
  el.innerHTML = styleSource(src);
  assert(el.textContent === src, "fence block roundtrip with concealed fences");
  const fences = [...el.querySelectorAll(".md-tok.md-fence")];
  assert(fences.length === 2, "both fence lines tokenized");
  applyMarkerVisibility(el, src, 11); // caret inside the code line
  assert(fences.every((f) => !f.classList.contains("md-on")),
    "caret in code keeps both fences concealed");
  applyMarkerVisibility(el, src, 2); // caret inside the opening fence
  assert(fences[0].classList.contains("md-on") && !fences[1].classList.contains("md-on"),
    "caret in opening fence reveals only it");

  const two = host();
  two.innerHTML = styleSource("```\n```");
  assert(two.textContent === "```\n```", "empty fence pair roundtrips (no doubled newline)");
}

/* ---------- table resize (toolbar grid picker backend) ---------- */
{
  const { tableDims, resizeTable } = await import(
    await (async () => {
      const out = path.join(here, ".build", "tabletools.mjs");
      await build({
        entryPoints: [path.join(here, "..", "src", "tabletools.ts")],
        bundle: true,
        format: "esm",
        outfile: out,
      });
      return out;
    })()
  );
  const src = "| a | b |\n| --- | :-: |\n| 1 | 2 |";
  assert(JSON.stringify(tableDims(src)) === '{"rows":2,"cols":2}',
    "tableDims counts header+body rows and columns");
  assert(tableDims("not a table") === null, "tableDims null for non-tables");

  const grown = resizeTable(src, 4, 3);
  const dims = tableDims(grown);
  assert(JSON.stringify(dims) === '{"rows":4,"cols":3}', `resize grows to 4x3 (${JSON.stringify(dims)})`);
  assert(grown.includes("| a |") && grown.includes("| 1 |"), "existing cells survive growth");
  assert(grown.split("\n")[1].includes(":---:"), "alignment survives growth (canonical :---:)");

  const shrunk = resizeTable(grown, 2, 1);
  assert(JSON.stringify(tableDims(shrunk)) === '{"rows":2,"cols":1}', "resize shrinks to 2x1");
  assert(shrunk.split("\n")[0].includes("a"), "header cell survives shrink");

  assert(resizeTable(src, 1, 0) !== null && tableDims(resizeTable(src, 1, 0)).rows === 2,
    "rows clamp to header + one body row");

  const { cellRanges } = await import(path.join(here, ".build", "tabletools.mjs"));
  // "| a | b |\n| --- | :-: |\n| 1 | 2 |" — a@2, b@6, 1@... line2 starts at 24.
  const ranges = cellRanges(src);
  assert(ranges.length === 4, `four cells in tab order (${ranges.length})`);
  assert(src.slice(ranges[0].start, ranges[0].end) === "a", "first cell range covers 'a'");
  assert(src.slice(ranges[1].start, ranges[1].end) === "b", "second cell range covers 'b'");
  assert(src.slice(ranges[2].start, ranges[2].end) === "1", "third cell skips the separator row");
  assert(src.slice(ranges[3].start, ranges[3].end) === "2", "fourth cell covers '2'");
  const blanks = cellRanges("| a |\n| --- |\n|   |");
  assert(blanks.length === 2 && blanks[1].start === blanks[1].end,
    "whitespace-only cell collapses to a caret position");
  assert(cellRanges("not a table").length === 0, "cellRanges empty for non-tables");
}

/* ---------- inline reveal: bold ---------- */
// "a **b** c" — the bold token spans source [2, 9].
{
  const src = "a **b** c";
  const el = host();
  el.innerHTML = styleSource(src);
  const tokOn = () => el.querySelector(".md-tok").classList.contains("md-on");

  applyMarkerVisibility(el, src, 4);
  assert(tokOn(), "caret inside bold reveals markers");
  applyMarkerVisibility(el, src, 0);
  assert(!tokOn(), "caret outside bold hides markers");
  applyMarkerVisibility(el, src, 2);
  assert(tokOn(), "caret on start edge reveals (inclusive)");
  applyMarkerVisibility(el, src, 7);
  assert(tokOn(), "caret on end edge reveals — just-completed pair stays visible");
  applyMarkerVisibility(el, src, 8);
  assert(!tokOn(), "caret one past the end edge hides again");
  // content styling survives hiding
  assert(el.querySelector("strong")?.textContent === "b", "bold content stays <strong> when hidden");
}

/* ---------- heading prefix reveal (caret-scoped, NOT line-scoped) ---------- */
// "## Head\nbody text" — the hash prefix token spans source [0, 3].
{
  const src = "## Head\nbody text";
  const el = host();
  el.innerHTML = styleSource(src);
  const preTok = () => el.querySelector(".md-tok.md-pre").classList.contains("md-on");

  applyMarkerVisibility(el, src, 5); // inside the heading text — stays rendered
  assert(!preTok(), "caret in heading text hides hashes (re-entered heading looks rendered)");
  applyMarkerVisibility(el, src, 7); // end of heading line
  assert(!preTok(), "caret at heading line end hides hashes");
  applyMarkerVisibility(el, src, 3); // start of the text = prefix end edge
  assert(preTok(), "caret at text start (prefix edge) reveals hashes — keeps them reachable");
  applyMarkerVisibility(el, src, 1); // inside the hashes
  assert(preTok(), "caret inside hashes reveals them");
  applyMarkerVisibility(el, src, 12); // on the body line
  assert(!preTok(), "caret on another line hides hashes");
}

/* ---------- list prefix reveal + per-line independence ---------- */
// "- alpha\n- [x] beta" — bullet prefix [0, 2], task prefix [8, 14].
{
  const src = "- alpha\n- [x] beta";
  const el = host();
  el.innerHTML = styleSource(src);
  const toks = () => [...el.querySelectorAll(".md-tok.md-pre")];
  assert(toks().length === 2, "both list prefixes tokenized");

  applyMarkerVisibility(el, src, src.length); // caret at end of "beta"
  assert(toks().every((t) => !t.classList.contains("md-on")),
    "caret at end of item text leaves every marker hidden (block looks rendered)");
  applyMarkerVisibility(el, src, 9); // inside "- [x] "
  assert(!toks()[0].classList.contains("md-on") && toks()[1].classList.contains("md-on"),
    "caret inside a marker reveals only that line's marker");
  assert(toks()[1].classList.contains("md-done"), "checked task carries md-done for the ☑ stand-in");
}

/* ---------- link reveal + URL hides with markers ---------- */
{
  const src = "x [lab](http://u) y";
  const el = host();
  el.innerHTML = styleSource(src);
  const tok = el.querySelector(".md-tok");

  applyMarkerVisibility(el, src, 0);
  assert(!tok.classList.contains("md-on"), "caret outside link hides its markers");
  const url = el.querySelector(".md-url");
  assert(
    url.classList.contains("md-mark"),
    "URL span carries md-mark so the generic hide rule catches it"
  );
  assert(url.closest(".md-tok") === tok, "URL span is inside the link token");
  applyMarkerVisibility(el, src, 4); // inside the label
  assert(tok.classList.contains("md-on"), "caret inside link reveals brackets and URL");
}

/* ---------- nested token: link inside bold, independent ranges ---------- */
// "**[a](u)** t" — bold spans [0, 10]; link spans [2, 8].
{
  const src = "**[a](u)** t";
  const el = host();
  el.innerHTML = styleSource(src);
  const toks = [...el.querySelectorAll(".md-tok")];
  assert(toks.length === 2, "nested markup produces two tokens");
  applyMarkerVisibility(el, src, 12);
  assert(toks.every((t) => !t.classList.contains("md-on")), "caret outside hides both");
  applyMarkerVisibility(el, src, 1); // inside bold's opening **, before the link
  const on = toks.map((t) => t.classList.contains("md-on"));
  assert(on.includes(true) && on.includes(false), "caret in bold marker reveals bold but not the inner link");
}

console.log(`${passes} passed, ${failures} failed`);
if (failures) process.exit(1);
