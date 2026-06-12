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
assert(
  styleSource("# H").includes("md-tok md-line"),
  "heading hashes wrapped in md-tok md-line"
);

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

/* ---------- heading line reveal ---------- */
{
  const src = "## Head\nbody text";
  const el = host();
  el.innerHTML = styleSource(src);
  const lineTok = () => el.querySelector(".md-tok.md-line").classList.contains("md-on");

  applyMarkerVisibility(el, src, 5); // on the heading line, outside the hashes
  assert(lineTok(), "caret anywhere on heading line reveals hashes");
  applyMarkerVisibility(el, src, 7); // end of heading line
  assert(lineTok(), "caret at heading line end reveals hashes");
  applyMarkerVisibility(el, src, 12); // on the body line
  assert(!lineTok(), "caret on another line hides hashes");
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
