import { For, createSelector, onMount, onCleanup } from "solid-js";
import Block from "./Block";
import {
  doc, setActive, updateBlock, mergeWithPrevious, insertBlockAfter,
  splitBlock, setHeading, requestCaret, replaceBlocks,
} from "../store";
import { toggleTask } from "../markdown";
import { selectedSourceRange } from "../blockselect";
import { deleteSourceRange } from "../livesource";
import { pasteToInsert } from "../richpaste";
import { openEditorMenu } from "./EditorContextMenu";
import { parseTable } from "../tabletools";

export default function Editor() {
  // Make a selection outside the block being edited actionable: one that
  // spans blocks (a native selection can't edit across them, since each block
  // is its own render/edit host), or one dragged inside a rendered block.
  // Only the selected source is replaced, not the blocks it touches. A
  // selection inside the edited block is that block's own to handle.
  onMount(() => {
    /** The blocks a selection touches, joined, with its offsets in that text. */
    const selected = () => {
      const r = selectedSourceRange();
      if (!r) return null;
      let from = 0;
      for (let i = r.start.block; i < r.end.block; i++) from += doc.blocks[i].text.length + 2;
      const text = doc.blocks.slice(r.start.block, r.end.block + 1).map((b) => b.text).join("\n\n");
      return { first: r.start.block, last: r.end.block, text, start: r.start.offset, end: from + r.end.offset };
    };
    /** Replace the selection with `insert`, leaving the caret after it. */
    const replace = (s: NonNullable<ReturnType<typeof selected>>, insert: string) => {
      const cut = deleteSourceRange(s.text, s.start, s.end);
      window.getSelection()?.removeAllRanges();
      replaceBlocks(s.first, s.last, cut.text.slice(0, cut.caret) + insert + cut.text.slice(cut.caret), cut.caret + insert.length);
    };
    // Dialogs and form fields (sidebar filter, find bar) keep their own keys.
    const inModal = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('[aria-modal="true"], input, textarea, select');
    const clipboard = (e: ClipboardEvent, cut: boolean) => {
      if (inModal(e)) return;
      const s = selected();
      if (!s) return;
      e.preventDefault();
      e.clipboardData?.setData("text/plain", s.text.slice(s.start, s.end));
      if (cut) replace(s, "");
    };
    const onCopy = (e: ClipboardEvent) => clipboard(e, false);
    const onCut = (e: ClipboardEvent) => clipboard(e, true);
    const onPaste = (e: ClipboardEvent) => {
      if (inModal(e)) return;
      const s = selected();
      if (!s || !e.clipboardData) return;
      e.preventDefault();
      replace(s, pasteToInsert({ html: e.clipboardData.getData("text/html"), plain: e.clipboardData.getData("text/plain"), inFence: false }));
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (inModal(e) || e.isComposing) return;
      const s = selected();
      if (!s) return;
      if (e.key === "Backspace" || e.key === "Delete" || e.key === "Enter") {
        e.preventDefault();
        replace(s, "");
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        replace(s, e.key);
      }
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

  // Notifies only the blocks gaining and losing focus, rather than every
  // block re-comparing its index on each activation.
  const isActive = createSelector(() => doc.activeIndex);

  const navigate = (index: number, dir: -1 | 1) => {
    const next = index + dir;
    if (next < 0) return;
    if (next >= doc.blocks.length) {
      if (doc.blocks[index].text.trim() !== "") insertBlockAfter(index);
      return;
    }
    // Arrow down enters the next block at its start; arrow up arrives at the
    // end of the previous one — line-by-line, never skipping content.
    requestCaret(dir === 1 ? 0 : doc.blocks[next].text.length);
    setActive(next);
  };

  return (
    <div
      class="editor" tabIndex={0} role="region" aria-label="Document editor. Press Enter to edit."
      aria-keyshortcuts="Shift+F10 ContextMenu"
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && e.key === "Enter") {
          e.preventDefault(); requestCaret(0); setActive(Math.max(0, doc.activeIndex));
        }
        // Keyboard access to the context menu. Browsers on macOS don't turn
        // Shift+F10 into a contextmenu event, so open it here on every platform.
        if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
          e.preventDefault();
          const sel = window.getSelection();
          const i = doc.activeIndex;
          openEditorMenu(0, 0, sel && !sel.isCollapsed ? sel.toString() : "", i >= 0 && !!parseTable(doc.blocks[i].text));
        }
      }}
      onContextMenu={(e) => {
        // Catch-all for right-clicks in the editor (gutter/padding). Block and
        // image handlers stopPropagation for clicks on their own content, so
        // this only fires for the surrounding area — right-click always menus.
        e.preventDefault();
        const sel = window.getSelection();
        openEditorMenu(e.clientX, e.clientY, sel && !sel.isCollapsed ? sel.toString() : "");
      }}
      onMouseDown={(e) => {
        // Clicks that land inside a block are the block's own concern.
        const t = e.target as HTMLElement;
        if (t.closest(".block")) return;

        // Empty space — gutter beside a line, or padding below the document.
        // Activate the block nearest the click's Y, NOT always the last one
        // (which jumped the viewport to the bottom). Only the trailing
        // padding, below all content, appends/lands at the end.
        const blocks = [...(e.currentTarget as HTMLElement).querySelectorAll(".block")];
        if (!blocks.length) return;
        const y = e.clientY;
        const lastIdx = doc.blocks.length - 1;
        const belowAll = y > blocks[blocks.length - 1].getBoundingClientRect().bottom;
        if (belowAll) {
          e.preventDefault();
          if (doc.blocks[lastIdx].text.trim() === "") setActive(lastIdx);
          else insertBlockAfter(lastIdx);
          return;
        }
        // Beside or between blocks: pick the one vertically nearest the click.
        let best = 0;
        let bestDist = Infinity;
        blocks.forEach((b, i) => {
          const r = b.getBoundingClientRect();
          const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
          if (d < bestDist) { bestDist = d; best = i; }
        });
        e.preventDefault();
        setActive(best);
      }}
    >
      <div class="page">
        <For each={doc.blocks}>
          {(block, i) => (
            <Block
              id={block.id}
              index={i()}
              text={block.text}
              active={isActive(i())}
              onActivate={(caret) => {
                if (caret != null) requestCaret(caret);
                setActive(i());
              }}
              onChange={(t) => updateBlock(i(), t)}
              onDeactivate={() => doc.activeIndex === i() && setActive(-1)}
              onNavigate={(dir) => navigate(i(), dir)}
              onMergePrev={() => mergeWithPrevious(i())}
              onSplit={(before, after) => splitBlock(i(), before, after)}
              onToggleTask={(nth) => updateBlock(i(), toggleTask(block.text, nth))}
              setHeading={(lvl) => setHeading(i(), lvl)}
            />
          )}
        </For>
      </div>
    </div>
  );
}
