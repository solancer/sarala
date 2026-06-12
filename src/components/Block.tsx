import { Show, createEffect, on, onCleanup } from "solid-js";
import { renderMarkdown, hasOpenFence } from "../markdown";
import {
  styleSource, getCaretOffset, getSelectionOffsets, setCaret, setSelection,
  applyMarkerVisibility, mapRenderedPrefixToSource,
} from "../livesource";
import { isTauri, openExternal } from "../platform";
import {
  consumeCaretRequest, consumeSelectionRequest,
  spellcheckOn, smartPunctuation, renderEpoch,
} from "../store";
import { executeCommand, registerBlockApi, unregisterBlockApi, type BlockApi } from "../commands";
import { parseTable, cellRanges } from "../tabletools";
import TableToolbar from "./TableToolbar";

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
  let rootEl: HTMLDivElement | undefined;
  let pendingCaret: number | null = null;
  let composing = false;
  let lastRevealCaret = -1;

  const reveal = (caret: number) => {
    if (!el) return;
    lastRevealCaret = caret;
    applyMarkerVisibility(el, props.text, caret);
  };

  const isFence = () => /^\s*(`{3,}|~{3,})/.test(props.text) || props.text.startsWith("---\n");

  // Block-type class so the live view's box metrics match the rendered view
  // (same margins the rendered elements carry) — activation must not shift
  // the layout below.
  const blockType = () => {
    const t = props.text;
    if (isFence()) return "";
    const h = t.match(/^(#{1,6})\s/);
    if (h) return `b-h${h[1].length}`;
    if (/^\s*>/.test(t)) return "b-quote";
    if (parseTable(t)) return "b-table";
    if (/^\s*(?:[-*+]|\d+\.)\s/.test(t)) return "b-list";
    return "b-p";
  };

  // Re-style the live source whenever the text changes while active,
  // restoring the caret to where the user left it.
  createEffect(
    on([() => props.active, () => props.text], ([active]) => {
      if (!active || !el || composing) return;
      const selection = consumeSelectionRequest();
      const caret = pendingCaret ?? consumeCaretRequest() ?? props.text.length;
      pendingCaret = null;
      el.innerHTML = styleSource(props.text);
      el.focus();
      if (selection) {
        setSelection(el, selection.start, selection.end);
        el.scrollIntoView({ block: "nearest" });
        reveal(selection.start);
      } else {
        setCaret(el, caret);
        reveal(caret);
      }
    })
  );

  // Pure caret movement (arrows, clicks) must update marker reveal without
  // resetting innerHTML — re-styling would interrupt selection drags.
  createEffect(() => {
    if (!props.active) return;
    const onSelectionChange = () => {
      if (!el || composing) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || !el.contains(sel.anchorNode)) return;
      const offset = getCaretOffset(el);
      if (offset === lastRevealCaret) return;
      reveal(offset);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    onCleanup(() => document.removeEventListener("selectionchange", onSelectionChange));
  });

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

  // While active, expose caret-level editing to the menu/keyboard command bus.
  const api: BlockApi = {
    wrap: wrapSelection,
    insertAtCaret: (t, c) => insertAtCaret(t, c),
    selectRange: (start, end) => {
      if (!el) return;
      setSelection(el, start, end);
      el.scrollIntoView({ block: "nearest" });
    },
    caretOffset: () => (el ? getCaretOffset(el) : 0),
    selectionOffsets: () => (el ? getSelectionOffsets(el) : { start: 0, end: 0 }),
  };
  createEffect(() => {
    if (props.active) registerBlockApi(api);
    else unregisterBlockApi(api);
  });
  onCleanup(() => unregisterBlockApi(api));

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
      // Under Tauri these chords are native menu accelerators that dispatch
      // through the command bus; handling them here too would double-fire.
      if (isTauri) return;
      const k = e.key.toLowerCase();
      if (k === "b") return e.preventDefault(), executeCommand("format.strong");
      if (k === "i") return e.preventDefault(), executeCommand("format.emphasis");
      if (k === "e") return e.preventDefault(), executeCommand("format.code");
      if (k === "k") return e.preventDefault(), executeCommand("format.hyperlink");
      if (/^[0-6]$/.test(k)) return e.preventDefault(), executeCommand(`paragraph.heading.${k}`);
      return;
    }
    // Browser fallback for Alt+Up/Down (native menu accelerator in Tauri).
    if (!isTauri && e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.preventDefault();
      executeCommand(e.key === "ArrowUp" ? "edit.move_row_up" : "edit.move_row_down");
      return;
    }
    // Smart punctuation: curly quotes and -- → em-dash (skipped in code fences).
    if (smartPunctuation() && !isFence() && !e.altKey) {
      if (e.key === '"' || e.key === "'") {
        e.preventDefault();
        const { start } = getSelectionOffsets(el!);
        const prev = start > 0 ? props.text[start - 1] : "";
        const opening = !prev || /[\s([{“‘—-]/.test(prev);
        insertAtCaret(e.key === '"' ? (opening ? "“" : "”") : opening ? "‘" : "’");
        return;
      }
      if (e.key === "-") {
        const { start, end } = getSelectionOffsets(el!);
        if (start === end && props.text[start - 1] === "-") {
          e.preventDefault();
          commit(props.text.slice(0, start - 1) + "—" + props.text.slice(end), start);
          return;
        }
      }
    }
    if (e.key === "Escape") { e.preventDefault(); el?.blur(); return; }
    if (e.key === "Tab") {
      e.preventDefault();
      // In a table, Tab cycles through cells (selecting each cell's content),
      // wrapping from a row's last column to the next row and from the table's
      // end back to the first cell. Shift+Tab goes backward.
      const cells = cellRanges(props.text);
      if (cells.length && el) {
        const { start } = getSelectionOffsets(el);
        let idx = cells.findIndex((c) => start <= c.end);
        if (idx === -1) idx = 0;
        const next = e.shiftKey ? (idx - 1 + cells.length) % cells.length : (idx + 1) % cells.length;
        setSelection(el, cells[next].start, cells[next].end);
        return;
      }
      insertAtCaret("  ");
      return;
    }
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
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      // Leave the block only from its first/last VISUAL line — wrapped
      // paragraphs have one source line but many visual lines, and the
      // browser must keep handling movement between those.
      if (!el) return;
      const sel = window.getSelection();
      if (!sel?.rangeCount) return;
      const range = sel.getRangeAt(0).cloneRange();
      range.collapse(e.key === "ArrowUp");
      let rect: DOMRect | undefined = range.getClientRects()[0];
      if (!rect) {
        // Empty line or caret inside hidden text: fall back to the nearest
        // element box.
        const n = range.startContainer;
        rect = (n instanceof Element ? n : n.parentElement)?.getBoundingClientRect();
      }
      if (!rect) return;
      const cs = getComputedStyle(el);
      const host = el.getBoundingClientRect();
      const line = rect.height || parseFloat(cs.lineHeight) || 24;
      if (e.key === "ArrowUp") {
        const innerTop = host.top + parseFloat(cs.paddingTop);
        if (rect.top - innerTop < line * 0.5) { e.preventDefault(); props.onNavigate(-1); }
      } else {
        const innerBottom = host.bottom - parseFloat(cs.paddingBottom);
        if (innerBottom - rect.bottom < line * 0.5) { e.preventDefault(); props.onNavigate(1); }
      }
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
    <div class="block" classList={{ active: props.active }} ref={rootEl}>
      <Show when={props.active && parseTable(props.text)}>
        <TableToolbar text={props.text} />
      </Show>
      <Show
        when={props.active}
        fallback={
          // eslint-disable-next-line solid/no-innerhtml -- renderMarkdown output is DOMPurify-sanitized
          <div class="rendered" onMouseDown={onRenderedClick} innerHTML={(renderEpoch(), renderMarkdown(props.text))} />
        }
      >
        <div
          ref={el}
          class={`source ${blockType()}`}
          classList={{ "code-block": isFence() }}
          contentEditable={true}
          spellcheck={spellcheckOn()}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onBlur={(e) => {
            // Keep the block active when focus leaves the page itself (native
            // menu click, app switch) or moves into this block's own chrome
            // (table toolbar inputs), so commands still have a target.
            const to = e.relatedTarget as Node | null;
            if (document.hasFocus() && !(to && rootEl?.contains(to))) props.onDeactivate();
          }}
          onCompositionStart={() => (composing = true)}
          onCompositionEnd={() => { composing = false; onInput(); }}
        />
      </Show>
    </div>
  );
}
