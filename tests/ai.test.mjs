/**
 * Tests for the AI assistant's pure modules (src/ai/): the agent CLI output
 * parsers (against real captured output in tests/fixtures/ai/), the working
 * copy layout, turning an edited copy into proposals, resolving proposals
 * against a changed document, batch planning, and the word diff.
 *
 *   node tests/ai.test.mjs   (part of `pnpm test`)
 *
 * The load-bearing property: no proposal is ever applied to text other than
 * the text it was made against.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, ".build", "ai");
const src = (f) => path.join(here, "..", "src", "ai", f);

await build({
  entryPoints: ["agents.ts", "document.ts", "proposals.ts", "diff.ts", "prompts.ts", "persist.ts"].map(src),
  bundle: true,
  format: "esm",
  platform: "node",
  outdir,
  logLevel: "error",
});
const load = (name) => import(path.join(outdir, `${name}.js`));
const agents = await load("agents");
const docmod = await load("document");
const proposals = await load("proposals");
const prompts = await load("prompts");
const { wordDiff } = await load("diff");
const persist = await load("persist");

let passed = 0;
const test = (name, fn) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};
const fixture = (name) => readFileSync(path.join(here, "fixtures", "ai", name), "utf8").split("\n").filter(Boolean);
const feedAll = (parser, lines) => lines.flatMap((l) => parser.feed(typeof l === "string" ? l : JSON.stringify(l)));
const textOf = (events) => events.filter((e) => e.kind === "text").map((e) => e.delta).join("");

/* ---------- agent output parsers ---------- */

test("Claude Code: real stream-json run", () => {
  const events = feedAll(agents.claudeParser(), fixture("claude-code.jsonl"));
  assert.equal(textOf(events), 'I changed "Teh" to "The" on line 3 of `doc.md`.');
  assert.ok(events.some((e) => e.kind === "session" && e.id === "ad49dd73-b3b2-4656-8168-912a65b0b52e"));
  const acts = events.filter((e) => e.kind === "activity").map((e) => e.label);
  assert.deepEqual(acts, ["Reading the document…", "Editing the document…"]);
  assert.equal(events.filter((e) => e.kind === "error").length, 0);
});

test("Claude Code: text of successive model calls is separated; errors and subagents", () => {
  const delta = (text) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
  const start = { type: "stream_event", event: { type: "message_start" } };
  const events = feedAll(agents.claudeParser(), [
    start, delta("First."), start, delta("Second"), delta(" part."),
    { ...delta("hidden"), parent_tool_use_id: "toolu_x" },
    { type: "result", subtype: "error_max_turns", is_error: true, session_id: "s1" },
  ]);
  assert.equal(textOf(events), "First.\n\nSecond part.");
  assert.ok(events.some((e) => e.kind === "error"));
  const auth = feedAll(agents.claudeParser(), [{ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }]);
  assert.deepEqual(auth.filter((e) => e.kind === "error").map((e) => e.message), ["Invalid API key · Please run /login"]);
  assert.deepEqual(agents.claudeParser().feed("not json"), []);
});

test("Codex: real exec --json run", () => {
  const events = feedAll(agents.codexParser(), fixture("codex.jsonl"));
  assert.equal(textOf(events), "I’ll fix the typo in `doc.md`.\n\nFixed “Teh” to “The” in `doc.md`.");
  assert.ok(events.some((e) => e.kind === "session" && e.id === "01a0ee8d-d288-7af3-89c3-36343174ae41"));
  assert.ok(events.some((e) => e.kind === "activity" && e.label === "Editing the document…"));
  assert.ok(events.some((e) => e.kind === "activity" && e.label === "Running a command…"));
  const failed = feedAll(agents.codexParser(), [{ type: "turn.failed", error: { message: "stream error: 401 Unauthorized" } }]);
  assert.deepEqual(failed, [{ kind: "error", message: "stream error: 401 Unauthorized" }]);
});

test("Copilot CLI: errors, session id, deltas vs whole messages", () => {
  // session.error and result are real captured shapes; assistant.* are best-effort.
  const events = feedAll(agents.copilotParser(), [
    { type: "assistant.turn_start", data: { turnId: "0" } },
    { type: "tool.execution_start", data: { toolName: "edit" } },
    { type: "assistant.message_delta", data: { deltaContent: "Fixed " } },
    { type: "assistant.message_delta", data: { deltaContent: "it." } },
    { type: "assistant.message", data: { content: "Fixed it." } },
    { type: "assistant.message", data: { content: "Anything else?" } },
    { type: "session.error", data: { errorType: "quota", message: "402 You have exceeded your monthly quota" } },
    { type: "result", sessionId: "c30000ea-5896-40d2-be0c-8f542f7bf371", exitCode: 1 },
  ]);
  assert.equal(textOf(events), "Fixed it.\n\nAnything else?");
  assert.ok(events.some((e) => e.kind === "activity" && e.label === "Editing the document…"));
  assert.ok(events.some((e) => e.kind === "error" && /quota/.test(e.message)));
  assert.ok(events.some((e) => e.kind === "session" && e.id === "c30000ea-5896-40d2-be0c-8f542f7bf371"));
});

test("createParser picks the right parser", () => {
  const codexLine = JSON.stringify({ type: "thread.started", thread_id: "t" });
  assert.deepEqual(agents.createParser("codex").feed(codexLine), [{ kind: "session", id: "t" }]);
  assert.deepEqual(agents.createParser("claude-code").feed(codexLine), []);
});

/* ---------- working copy ---------- */

const blocks = [
  { id: 11, text: "# Title" },
  { id: 12, text: "Teh first paragraph." },
  { id: 13, text: "- one\n- two" },
];

test("working copy text, block lines and selection locations", () => {
  const snap = docmod.takeSnapshot(blocks);
  assert.equal(docmod.snapshotText(snap), "# Title\n\nTeh first paragraph.\n\n- one\n- two\n");
  assert.deepEqual(docmod.blockLines(snap), [{ start: 1, end: 1 }, { start: 3, end: 3 }, { start: 5, end: 6 }]);
  assert.equal(
    docmod.serializeReferences([{ id: "r", blockIds: [12, 13], quote: "Q" }], snap),
    '<selection location="lines 3-6 of document.md">\nQ\n</selection>',
  );
  assert.equal(
    docmod.serializeReferences([{ id: "r", blockIds: [12], quote: "first" }], snap),
    '<selection location="line 3 of document.md">\nfirst\n</selection>',
  );
});

test("turn prompt carries the rules, decisions, selection and request", () => {
  const p = prompts.turnPrompt({ name: "notes.md", resumed: true, decisions: ["the user rejected one of your changes"], selection: "<selection>x</selection>", request: "Fix it" });
  assert.match(p, /"notes\.md" is in \.\/document\.md/);
  assert.match(p, /Do not create, rename, or delete any other file/);
  assert.match(p, /Read it again before editing/);
  assert.match(p, /rejected one of your changes/);
  assert.ok(p.endsWith("Request: Fix it"));
  assert.doesNotMatch(prompts.turnPrompt({ name: "a", resumed: false, decisions: [], selection: "", request: "x" }), /Read it again/);
});

/* ---------- proposals from an edited copy ---------- */

const ids = () => { let n = 0; return () => `p${++n}`; };

test("diffBlocks: edit, insert, delete, untouched", () => {
  assert.deepEqual(proposals.diffBlocks(blocks, blocks.map((b) => b.text), ids()), []);
  const edit = proposals.diffBlocks(blocks, ["# Title", "The first paragraph.", "- one\n- two"], ids());
  assert.deepEqual(edit, [{ kind: "edit", id: "p1", blockIds: [12], original: "Teh first paragraph.", replacement: "The first paragraph.", status: "pending", at: 1 }]);
  const ins = proposals.diffBlocks(blocks, ["Intro", "# Title", "Teh first paragraph.", "New", "More", "- one\n- two"], ids());
  assert.deepEqual(ins.map((p) => [p.kind, p.afterBlockId, p.replacement]), [["insert", null, "Intro"], ["insert", 12, "New\n\nMore"]]);
  const del = proposals.diffBlocks(blocks, ["# Title", "- one\n- two"], ids());
  assert.deepEqual(del.map((p) => [p.kind, p.blockIds, p.replacement]), [["edit", [12], ""]]);
  const both = proposals.diffBlocks(blocks, ["# Better title", "Teh first paragraph.", "- one\n- two\n- three"], ids());
  assert.deepEqual(both.map((p) => p.blockIds), [[11], [13]], "separate regions become separate proposals");
  const each = proposals.diffBlocks(blocks, ["# Better", "The first paragraph.", "- one\n- two\n- three"], ids());
  assert.deepEqual(each.map((p) => p.blockIds), [[11], [12], [13]], "adjacent edits to each block stay separate");
  const merged = proposals.diffBlocks(blocks, ["# Title", "Merged into one."], ids());
  assert.deepEqual(merged.map((p) => p.blockIds), [[12, 13]], "a real merge stays one proposal");
});

test("diffBlocks: applying every proposal reproduces the edited copy (random, small and large)", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const apply = (before, props) => {
    const placed = props.map((p) => {
      const r = proposals.resolveProposal(p, before);
      assert.ok(r.ok, "every fresh proposal resolves");
      return { item: p, start: r.start, deleteCount: r.deleteCount };
    });
    const { apply: plan, conflicts } = proposals.planBatch(placed);
    assert.equal(conflicts.length, 0, "fresh proposals never overlap");
    const doc = before.map((b) => b.text);
    for (const { item, start, deleteCount } of plan) doc.splice(start, deleteCount, ...(item.replacement ? item.replacement.split("\n\n") : []));
    return doc;
  };
  for (const size of [0, 1, 5, 40, 3000]) {
    for (let round = 0; round < 6; round++) {
      // Mostly unique paragraphs plus some repeated ones (headings, separators);
      // odd rounds use heavily repeated content, where nothing is unique.
      const pool = round % 2 ? 12 : 1e9;
      const before = Array.from({ length: size }, (_, i) => ({ id: i + 1, text: rnd(10) ? `Paragraph ${i % pool}${round % 2 ? "" : ` ${rnd(1000)}`}` : "---" }));
      const after = before.map((b) => b.text).flatMap((t) => {
        const r = rnd(20);
        if (r === 0) return []; // delete
        if (r === 1) return [`${t} edited`]; // edit
        if (r === 2) return [t, `Inserted ${rnd(1000)}`]; // insert after
        return [t];
      });
      if (size && !rnd(3)) after.unshift("New intro");
      const t0 = performance.now();
      const props = proposals.diffBlocks(before, after, ids());
      const ms = performance.now() - t0;
      assert.deepEqual(apply(before, props), after, `size ${size} round ${round}`);
      if (size === 3000) {
        assert.ok(props.length > 100, `large documents get one proposal per edit (${props.length})`);
        assert.ok(ms < 100, `and diff quickly (${ms.toFixed(1)} ms)`);
      }
    }
  }
});

test("resolveProposal follows moved blocks and refuses changed text", () => {
  const [p] = proposals.diffBlocks(blocks, ["# Title", "Merged."], ids());
  assert.deepEqual(p.blockIds, [12, 13]);
  const moved = [{ id: 99, text: "New intro" }, ...blocks];
  assert.deepEqual(proposals.resolveProposal(p, moved), { ok: true, start: 2, deleteCount: 2 });
  const edited = blocks.map((b) => (b.id === 13 ? { ...b, text: "Changed." } : b));
  assert.equal(proposals.resolveProposal(p, edited).ok, false);
  const split = [blocks[0], blocks[1], { id: 50, text: "Wedged in" }, blocks[2]];
  assert.equal(proposals.resolveProposal(p, split).ok, false, "range must stay contiguous");
  assert.equal(proposals.resolveProposal(p, [blocks[0], blocks[2]]).ok, false);
  const [ins] = proposals.diffBlocks(blocks, ["# Title", "Added", "Teh first paragraph.", "- one\n- two"], ids());
  assert.deepEqual(proposals.resolveProposal(ins, moved), { ok: true, start: 2, deleteCount: 0 });
});

test("planBatch orders splices and rejects overlaps", () => {
  const P = (item, start, deleteCount) => ({ item, start, deleteCount });
  const { apply, conflicts } = proposals.planBatch([
    P("e1", 1, 2), // blocks 1-2
    P("e2", 2, 1), // overlaps e1
    P("i1", 2, 0), // insert inside e1
    P("i2", 3, 0), // insert right after e1: fine
    P("i3", 3, 0), // same spot, must end up after i2
    P("e3", 5, 1),
    P("i4", 1, 0), // insert before e1: fine
  ]);
  assert.deepEqual(conflicts, ["e2", "i1"]);
  assert.deepEqual(apply.map((a) => a.item), ["e3", "i3", "i2", "e1", "i4"]);
  const doc = ["a", "b", "c", "d", "e", "f"];
  const text = { e1: ["B+C"], i2: ["I2"], i3: ["I3"], e3: ["F"], i4: ["I4"] };
  for (const a of apply) doc.splice(a.start, a.deleteCount, ...text[a.item]);
  assert.deepEqual(doc, ["a", "I4", "B+C", "I2", "I3", "d", "e", "F"]);
});


/* ---------- saved chats ---------- */

test("reanchor finds pending changes by text after a restart", () => {
  const [edit] = proposals.diffBlocks(blocks, ["# Title", "The first paragraph.", "- one\n- two"], ids());
  const [ins] = proposals.diffBlocks(blocks, ["# Title", "Teh first paragraph.", "Added", "- one\n- two"], ids());
  // Same text, new ids (a restart), and a block added above.
  const reopened = [{ id: 1, text: "Preface" }, { id: 2, text: "# Title" }, { id: 3, text: "Teh first paragraph." }, { id: 4, text: "- one\n- two" }];
  assert.deepEqual(proposals.reanchor(edit, reopened).blockIds, [3]);
  assert.equal(proposals.reanchor(ins, reopened).afterBlockId, 3);
  assert.equal(proposals.reanchor(edit, [{ id: 9, text: "Rewritten meanwhile." }]), null);
  // Duplicate text: the occurrence nearest the old position wins.
  const dup = [{ id: 1, text: "Teh first paragraph." }, { id: 2, text: "x" }, { id: 3, text: "y" }, { id: 4, text: "Teh first paragraph." }];
  assert.deepEqual(proposals.reanchor({ ...edit, at: 3 }, dup).blockIds, [4]);
  assert.deepEqual(proposals.reanchor({ ...edit, at: 0 }, dup).blockIds, [1]);
});

test("chats round-trip through a save", () => {
  const chat = (id, extra = {}) => ({
    id, tab: 7, title: "T " + id, renamed: false, agent: "codex", started: true, refs: [], busy: false, unread: false,
    working: [], updatedAt: 5, proposals: {}, items: [{ kind: "user", id: "u", text: "hi", refs: [], prompt: "hi" }], ...extra,
  });
  const [pending] = proposals.diffBlocks(blocks, ["# Title", "The first paragraph.", "- one\n- two"], ids());
  const running = chat("c1", {
    items: [
      { kind: "user", id: "u", text: "fix", refs: [], prompt: "fix" },
      { kind: "assistant", id: "a", text: "Work", activity: "Editing", streaming: true },
      { kind: "proposal", id: pending.id },
    ],
    proposals: { [pending.id]: pending, gone: { kind: "edit", id: "gone", blockIds: [12], original: "Old", replacement: "New", status: "accepted" } },
  });
  const empty = chat("c2", { items: [] });
  const sessions = (id) => (id === "c1" ? { workspaceId: "w-c1", sessionId: "s-1", decisions: ["the user rejected one of your changes"] } : null);
  const saved = persist.toSaved([running, empty], "c2", sessions, blocks);
  assert.equal(saved.chats.length, 1, "empty chats aren't saved");
  assert.equal(saved.active, "c1", "active falls back to a saved chat");
  const json = JSON.parse(JSON.stringify(saved));

  const reopened = [{ id: 101, text: "# Title" }, { id: 102, text: "Teh first paragraph." }, { id: 103, text: "- one\n- two" }];
  const { active, chats } = persist.fromSaved(json, reopened);
  assert.equal(active, "c1");
  const [{ chat: back, session }] = chats;
  assert.deepEqual(session, { workspaceId: "w-c1", sessionId: "s-1", decisions: ["the user rejected one of your changes"] });
  assert.equal(back.items[1].streaming, false);
  assert.match(back.items[1].error, /Interrupted/);
  assert.deepEqual(back.proposals[pending.id].blockIds, [102], "pending change re-anchored to the new block id");
  assert.equal(back.proposals[pending.id].status, "pending");
  assert.equal(back.proposals.gone.status, "accepted", "decided changes are kept as history");

  const edited = [{ id: 201, text: "# Title" }, { id: 202, text: "Different now." }];
  assert.equal(persist.fromSaved(json, edited).chats[0].chat.proposals[pending.id].status, "stale");
  assert.deepEqual(persist.fromSaved({ version: 99, chats: [] }, reopened), { active: null, chats: [] });
  assert.deepEqual(persist.fromSaved(null, reopened), { active: null, chats: [] });
});

/* ---------- diff ---------- */

test("wordDiff reconstructs both sides", () => {
  const before = "Teh quick brown fox, jumped.";
  const after = "The quick red fox jumped!";
  const parts = wordDiff(before, after);
  assert.equal(parts.filter((p) => p.type !== "add").map((p) => p.text).join(""), before);
  assert.equal(parts.filter((p) => p.type !== "del").map((p) => p.text).join(""), after);
  assert.ok(parts.some((p) => p.type === "same" && p.text.includes("quick")));
  assert.deepEqual(wordDiff("", "new"), [{ type: "add", text: "new" }]);
  const big = "word ".repeat(1000);
  assert.equal(wordDiff(big, big + "x").length, 2, "large inputs fall back to whole-text del/add");
});

console.log(`\n${passed} passed`);
