import { For, onMount, onCleanup } from "solid-js";
import Block from "./Block";
import {
  doc, setActive, updateBlock, mergeWithPrevious, insertBlockAfter,
  splitBlock, setHeading, requestCaret, replaceBlocks,
} from "../store";
import { toggleTask } from "../markdown";
import { selectedBlockRange } from "../blockselect";
import { openEditorMenu } from "./EditorContextMenu";

export default function Editor() {
  // Make a selection that spans blocks actionable (native selection can't,
  // since each block is its own render/edit host). Single-block and collapsed
  // selections fall through to the browser's own handling.
  onMount(() => {
    const clipboard = (e: ClipboardEvent, cut: boolean) => {
      const r = selectedBlockRange();
      if (!r) return;
      e.preventDefault();
      const md = doc.blocks.slice(r.start, r.end + 1).map((b) => b.text).join("\n\n");
      e.clipboardData?.setData("text/plain", md);
      if (cut) replaceBlocks(r.start, r.end, "");
    };
    const onCopy = (e: ClipboardEvent) => clipboard(e, false);
    const onCut = (e: ClipboardEvent) => clipboard(e, true);
    const onKeyDown = (e: KeyboardEvent) => {
      const r = selectedBlockRange();
      if (!r) return;
      if (e.key === "Backspace" || e.key === "Delete" || e.key === "Enter") {
        e.preventDefault();
        replaceBlocks(r.start, r.end, "");
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        replaceBlocks(r.start, r.end, e.key);
      }
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("keydown", onKeyDown);
    });
  });

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
      class="editor"
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
              text={block.text}
              active={doc.activeIndex === i()}
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
