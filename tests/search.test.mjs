import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const outfile = fileURLToPath(new URL("./.build/search.mjs", import.meta.url));
await build({ entryPoints: ["src/search.ts"], bundle: true, format: "esm", outfile });
const { buildSearchRegex, locateHit, matchLines } = await import(outfile);

const plain = { regex: false, caseSensitive: false, wholeWord: false };
const re = buildSearchRegex("needle", plain);

assert.equal(buildSearchRegex("", plain), null);
assert.equal(buildSearchRegex("(", { ...plain, regex: true }), null);
assert.ok(buildSearchRegex("(", plain), "a plain query is escaped, never invalid");

// A global pattern keeps state between calls: every line must still be tested.
assert.deepEqual(matchLines("needle\nneedle\r\n  a needle\nnone", re).map((m) => [m.line, m.text]),
  [[1, "needle"], [2, "needle"], [3, "a needle"]]);
assert.equal(matchLines("needle\n".repeat(80), re).length, 50);
assert.equal(matchLines("needle\n".repeat(80), re, 3).length, 3);
assert.equal([...matchLines(`needle ${"日".repeat(300)}`, re)[0].text].length, 200);

const blocks = ["# Needle", "plain", "- needle needle\n- none\n- needle"];
assert.deepEqual(locateHit(blocks, 0, re), { block: 0, ordinal: 0 });
assert.deepEqual(locateHit(blocks, 1, re), { block: 2, ordinal: 0 });
assert.deepEqual(locateHit(blocks, 2, re), { block: 2, ordinal: 2 }, "the line after two matches");
assert.equal(locateHit(blocks, 3, re), null);

// Hits count matching lines, so blank lines lost on opening don't move them.
const text = "needle\n\n\n\nneedle";
assert.equal(matchLines(text, re).length, 2);
assert.deepEqual(locateHit(["needle", "needle"], 1, re), { block: 1, ordinal: 0 });
console.log("search: all passed");
