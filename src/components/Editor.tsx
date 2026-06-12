import { For } from "solid-js";
import Block from "./Block";
import {
  doc, setActive, updateBlock, mergeWithPrevious, insertBlockAfter,
  splitBlock, setHeading, requestCaret,
} from "../store";
import { toggleTask } from "../markdown";

export default function Editor() {
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
      onMouseDown={(e) => {
        // Clicking empty space (the editor gutters or the page's padding
        // below the last block) starts writing at the end of the document.
        const t = e.target as HTMLElement;
        if (e.target === e.currentTarget || t.classList?.contains("page")) {
          const last = doc.blocks.length - 1;
          if (doc.blocks[last].text.trim() === "") setActive(last);
          else insertBlockAfter(last);
        }
      }}
    >
      <div class="page">
        <For each={doc.blocks}>
          {(block, i) => (
            <Block
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
