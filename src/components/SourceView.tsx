import { createEffect } from "solid-js";
import { fullText, replaceAll } from "../store";

export default function SourceView() {
  let el: HTMLTextAreaElement | undefined;

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
          }}
          spellcheck={false}
        />
      </div>
    </div>
  );
}
