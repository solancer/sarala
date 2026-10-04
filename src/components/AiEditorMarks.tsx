/**
 * Editor-side feedback for the AI assistant. Renders nothing itself; it keeps
 * classes on the block wrappers (never their styled content, so the block
 * invariant holds) and on the main column:
 *
 * - `ai-pending` / `ai-pending-after`: a margin marker on blocks with a change
 *   waiting for review;
 * - `ai-working`: a shimmer over the selection the agent is working on;
 * - `.main.ai-busy`: a thin progress line under the toolbar while it runs.
 *
 * Blocks can be re-created on edits, so classes are re-applied whenever the
 * block list or the inputs change.
 */
import { createEffect, onCleanup } from "solid-js";
import { activeTabId, doc, sourceMode } from "../store";
import { docBusy, docPendingProposals, workingBlockIds } from "../ai/session";

const MARKS = ["ai-pending", "ai-pending-after", "ai-pending-before", "ai-working"];

export default function AiEditorMarks() {
  let frame = 0;
  createEffect(() => {
    const blockIds = doc.blocks.map((b) => b.id);
    const pending = docPendingProposals();
    const working = new Set(workingBlockIds());
    const busy = docBusy();
    void activeTabId();
    void sourceMode();
    void doc.activeIndex;

    const cls = new Map<number, string[]>();
    const add = (id: number, c: string) => cls.set(id, [...(cls.get(id) ?? []), c]);
    for (const p of pending) {
      if (p.kind === "edit") p.blockIds.forEach((id) => add(id, "ai-pending"));
      else if (p.afterBlockId !== null) add(p.afterBlockId, "ai-pending-after");
      else if (blockIds.length) add(blockIds[0], "ai-pending-before");
    }
    for (const id of working) add(id, "ai-working");

    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      document.querySelector(".main")?.classList.toggle("ai-busy", busy);
      const els = document.querySelectorAll<HTMLElement>(".editor .page > .block");
      els.forEach((el, i) => {
        const want = cls.get(blockIds[i]) ?? [];
        for (const c of MARKS) el.classList.toggle(c, want.includes(c));
      });
    });
  });
  onCleanup(() => cancelAnimationFrame(frame));
  return null;
}
