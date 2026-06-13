import { fullText, replaceAll } from "../store";

export default function SourceView() {
  return (
    <div class="editor">
      <div class="page">
        <textarea
          class="source-full"
          value={fullText()}
          onInput={(e) => replaceAll(e.currentTarget.value)}
          spellcheck={false}
        />
      </div>
    </div>
  );
}
