import { createEffect } from "solid-js";
import { fullText, replaceAll, setSourceCaret } from "../store";

export default function SourceView() {
  let el: HTMLTextAreaElement | undefined;

  // Report the caret's line/column to the status bar. selectionStart counts
  // UTF-16 units from the start; line = newlines before it + 1.
  const reportCaret = () => {
    if (!el) return;
    const pos = el.selectionStart;
    const before = el.value.slice(0, pos);
    const nl = before.lastIndexOf("\n");
    let line = 1;
    for (let i = 0; i < before.length; i++) if (before.charCodeAt(i) === 10) line++;
    setSourceCaret({ line, col: pos - nl });
  };

  // Grow the textarea to fit its content so it never scrolls internally —
  // only the page (.scroll) scrolls, like the rendered view.
  const fit = () => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };
  createEffect(() => {
    fullText();
    queueMicrotask(fit);
  });

  return (
    <div class="editor">
      <div class="page">
        <textarea
          ref={el}
          class="source-full"
          value={fullText()}
          onInput={(e) => {
            replaceAll(e.currentTarget.value);
            fit();
            reportCaret();
          }}
          onKeyUp={reportCaret}
          onClick={reportCaret}
          onSelect={reportCaret}
          onFocus={reportCaret}
          spellcheck={false}
        />
      </div>
    </div>
  );
}
