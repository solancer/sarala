import { Show, createEffect, on } from "solid-js";
import { renderMarkdown, hasOpenFence } from "../markdown";
import {
  styleSource, getCaretOffset, getSelectionOffsets, setCaret,
  mapRenderedPrefixToSource,
} from "../livesource";
import { openExternal } from "../platform";
import { consumeCaretRequest } from "../store";

interface Props {
  text: string;
  active: boolean;
  onActivate: (caret?: number) => void;
  onChange: (text: string) => void;
  onDeactivate: () => void;
  onNavigate: (dir: -1 | 1) => void;
  onMergePrev: () => void;
  onSplit: (before: string, after: string) => void;
  onToggleTask: (nth: number) => void;
  setHeading: (level: number) => void;
}

export default function Block(props: Props) {
  let el: HTMLDivElement | undefined;
  let pendingCaret: number | null = null;
  let composing = false;

  const isFence = () => /^\s*(`{3,}|~{3,})/.test(props.text) || props.text.startsWith("---\n");

  // Re-style the live source whenever the text changes while active,
  // restoring the caret to where the user left it.
  createEffect(
    on([() => props.active, () => props.text], ([active]) => {
      if (!active || !el || composing) return;
      const caret = pendingCaret ?? consumeCaretRequest() ?? props.text.length;
      pendingCaret = null;
      el.innerHTML = styleSource(props.text);
      el.focus();
      setCaret(el, caret);
    })
  );

  const commit = (next: string, caret: number) => {
    pendingCaret = caret;
    props.onChange(next);
  };

  const insertAtCaret = (insert: string, caretWithin = insert.length) => {
    const { start, end } = getSelectionOffsets(el!);
    const t = props.text;
    commit(t.slice(0, start) + insert + t.slice(end), start + caretWithin);
  };

  const wrapSelection = (before: string, after = before) => {
    const { start, end } = getSelectionOffsets(el!);
    const t = props.text;
    const sel = t.slice(start, end) || "text";
    commit(
      t.slice(0, start) + before + sel + after + t.slice(end),
      start + before.length + sel.length + after.length
    );
  };

  const currentLine = (offset: number) => {
    const t = props.text;
    const start = t.lastIndexOf("\n", offset - 1) + 1;
    const endIdx = t.indexOf("\n", offset);
    const end = endIdx === -1 ? t.length : endIdx;
    return { start, end, line: t.slice(start, end) };
  };

  const handleEnter = () => {
    const offset = getCaretOffset(el!);
    const t = props.text;
    const { start, end, line } = currentLine(offset);

    // Just opened a fence on this line → newline + auto-close.
    const fenceHead = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceHead && hasOpenFence(t.slice(0, end))) {
      insertAtCaret("\n\n" + fenceHead[1], 1);
      return;
    }
    // Caret inside an open fence → plain newline.
    if (hasOpenFence(t.slice(0, offset))) {
      insertAtCaret("\n");
      return;
    }
    // List / quote continuation.
    const cont = line.match(/^(\s*)([-*+]\s+(?:\[[ xX]\]\s+)?|\d+\.\s+|(?:>\s*)+)/);
    if (cont) {
      const body = line.slice(cont[0].length);
      if (body.trim() === "" && offset >= end) {
        // Empty item ends the list: drop the marker line and split.
        const before = t.slice(0, start).replace(/\n$/, "");
        const after = t.slice(end).replace(/^\n/, "");
        props.onSplit(before, after);
        return;
      }
      let marker = cont[0];
      const num = marker.match(/^(\s*)(\d+)\.(\s+)$/);
      if (num) marker = `${num[1]}${Number(num[2]) + 1}.${num[3]}`;
      if (marker.match(/\[[xX]\]/)) marker = marker.replace(/\[[xX]\]/, "[ ]");
      insertAtCaret("\n" + marker);
      return;
    }
    // Plain paragraph: finalize this block, continue in a fresh one.
    props.onSplit(t.slice(0, offset), t.slice(offset));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (composing) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod) {
      const k = e.key.toLowerCase();
      if (k === "b") return e.preventDefault(), wrapSelection("**");
      if (k === "i") return e.preventDefault(), wrapSelection("*");
      if (k === "e") return e.preventDefault(), wrapSelection("`");
      if (k === "k") return e.preventDefault(), wrapSelection("[", "](url)");
      if (/^[0-6]$/.test(k)) return e.preventDefault(), props.setHeading(Number(k));
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); el?.blur(); return; }
    if (e.key === "Tab") { e.preventDefault(); insertAtCaret("  "); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) insertAtCaret("\n");
      else handleEnter();
      return;
    }
    if (e.key === "Backspace") {
      const { start, end } = getSelectionOffsets(el!);
      if (start === 0 && end === 0) { e.preventDefault(); props.onMergePrev(); }
      return;
    }
    if (e.key === "ArrowUp") {
      const o = getCaretOffset(el!);
      if (!props.text.slice(0, o).includes("\n")) { e.preventDefault(); props.onNavigate(-1); }
    }
    if (e.key === "ArrowDown") {
      const o = getCaretOffset(el!);
      if (!props.text.slice(o).includes("\n")) { e.preventDefault(); props.onNavigate(1); }
    }
  };

  const onInput = () => {
    if (!el || composing) return;
    pendingCaret = getCaretOffset(el);
    props.onChange(el.textContent ?? "");
  };

  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault();
    insertAtCaret(e.clipboardData?.getData("text/plain") ?? "");
  };

  const onRenderedClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.type === "checkbox") {
      e.preventDefault();
      const host = e.currentTarget as HTMLElement;
      const boxes = Array.from(host.querySelectorAll('input[type="checkbox"]'));
      props.onToggleTask(boxes.indexOf(t));
      return;
    }
    const link = t.closest("a");
    if (link?.getAttribute("href") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openExternal(link.getAttribute("href")!);
      return;
    }
    e.preventDefault();
    // Map the clicked position in rendered text back to a source offset.
    let caret: number | undefined;
    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    const host = e.currentTarget as HTMLElement;
    let range: Range | null = null;
    if (doc.caretRangeFromPoint) range = doc.caretRangeFromPoint(e.clientX, e.clientY);
    else if (doc.caretPositionFromPoint) {
      const pos = doc.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) { range = document.createRange(); range.setStart(pos.offsetNode, pos.offset); }
    }
    if (range && host.contains(range.startContainer)) {
      const pre = range.cloneRange();
      pre.selectNodeContents(host);
      pre.setEnd(range.startContainer, range.startOffset);
      caret = mapRenderedPrefixToSource(props.text, pre.toString());
    }
    props.onActivate(caret);
  };

  return (
    <div class="block" classList={{ active: props.active }}>
      <Show
        when={props.active}
        fallback={
          // eslint-disable-next-line solid/no-innerhtml -- renderMarkdown output is DOMPurify-sanitized
          <div class="rendered" onMouseDown={onRenderedClick} innerHTML={renderMarkdown(props.text)} />
        }
      >
        <div
          ref={el}
          class="source"
          classList={{ "code-block": isFence() }}
          contentEditable={true}
          spellcheck={true}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={() => props.onDeactivate()}
          onCompositionStart={() => (composing = true)}
          onCompositionEnd={() => { composing = false; onInput(); }}
        />
      </Show>
    </div>
  );
}
