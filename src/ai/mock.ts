/**
 * Scripted stand-in for an agent CLI, for development and the e2e tests. It
 * prints Claude Code's stream-json format and "edits" the working copy, so it
 * exercises the real parser and the diff-to-proposals flow without a CLI.
 *
 * Behaviour, keyed off the prompt:
 * - "Review" in the request: a text-only reply;
 * - "Proofread" without a selection: fixes "teh" everywhere;
 * - `globalThis.__saralaMockReply` set: replies with that text (benchmarks);
 * - a <selection>: fixes "teh" -> "the" (keeping case) on the selected lines,
 *   or appends " (revised)" to the last selected line when there is nothing
 *   to fix;
 * - otherwise: a text reply naming the block count.
 */
import type { RunCallbacks, RunHandle, RunRequest } from "./transport";

function script(req: RunRequest): { lines: string[]; document: string } {
  const request = req.prompt.slice(req.prompt.lastIndexOf("Request: ") + 9);
  const sel = req.prompt.match(/<selection location="lines? (\d+)(?:-(\d+))? of document\.md">/);
  const lines: unknown[] = [{ type: "system", subtype: "init", session_id: "mock-session" }];
  const say = (text: string) => {
    lines.push({ type: "stream_event", event: { type: "message_start" } });
    for (const piece of text.match(/.{1,12}/gs) ?? []) {
      lines.push({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } } });
    }
  };
  let document = req.document;

  const scripted = (globalThis as { __saralaMockReply?: string }).__saralaMockReply;
  if (scripted) {
    // Benchmarks: a long scripted reply.
    say(scripted);
  } else if (/proofread/i.test(request) && !sel) {
    // Whole-document edit: fix every "teh".
    document = document.replace(/\bteh\b/g, "the").replace(/\bTeh\b/g, "The");
    say("Fixed the typos.");
  } else if (/review/i.test(request)) {
    say("1. The title could be more specific.\n\nOverall the document is clear.");
  } else if (sel) {
    const lo = Number(sel[1]) - 1;
    const hi = (sel[2] ? Number(sel[2]) : lo + 1) - 1;
    const docLines = document.split("\n");
    let changed = false;
    for (let i = lo; i <= hi && i < docLines.length; i++) {
      const fixed = docLines[i].replace(/\bteh\b/g, "the").replace(/\bTeh\b/g, "The");
      changed ||= fixed !== docLines[i];
      docLines[i] = fixed;
    }
    if (!changed && docLines[hi] !== undefined) docLines[hi] += " (revised)";
    document = docLines.join("\n");
    say("Here is a suggested edit.");
    lines.push({ type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Edit" } } });
    say("Done. Review the change in the panel.");
  } else {
    const blocks = document.split(/\n\s*\n/).filter((b) => b.trim()).length;
    say(`Mock reply: the document has ${blocks} block${blocks === 1 ? "" : "s"}.`);
  }
  lines.push({ type: "result", subtype: "success", is_error: false, session_id: "mock-session" });
  return { lines: lines.map((l) => JSON.stringify(l)), document };
}

export function mockRun(req: RunRequest, cb: RunCallbacks): RunHandle {
  const { lines, document } = script(req);
  let stopped = false;
  let i = 0;
  const tick = () => {
    if (stopped) return;
    if (i >= lines.length) return cb.onExit({ code: 0, document, stderr: null, cancelled: false });
    cb.onLine(lines[i++]);
    // Tests and demos can slow the mock down to observe the running state.
    setTimeout(tick, (globalThis as { __saralaMockDelay?: number }).__saralaMockDelay ?? 8);
  };
  setTimeout(tick, 30);
  return {
    cancel: () => {
      if (stopped) return;
      stopped = true;
      cb.onExit({ code: null, document: null, stderr: "Stopped.", cancelled: true });
    },
  };
}
