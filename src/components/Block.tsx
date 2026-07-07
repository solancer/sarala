import { Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { renderMarkdown, hasOpenFence } from "../markdown";
import {
  styleSource, getCaretOffset, getSelectionOffsets, setCaret, setSelection,
  applyMarkerVisibility, mapRenderedPrefixToSource,
} from "../livesource";
import { isTauri, openExternal, pickImageFile } from "../platform";
import {
  consumeCaretRequest, consumeSelectionRequest,
  spellcheckOn, smartPunctuation, renderEpoch, mermaidEpoch,
  setLiveCaretOffset,
} from "../store";
import { renderMermaidIn } from "../mermaid";
import { renderD2In } from "../d2";
import { executeCommand, registerBlockApi, unregisterBlockApi, imageInsertRef, type BlockApi } from "../commands";
import { parseTable, cellRanges } from "../tabletools";
import { findImages } from "../images";
import { pasteToInsert } from "../richpaste";
import { openImageMenu } from "./ImageContextMenu";
import { openEditorMenu } from "./EditorContextMenu";
import ImageHoverTools from "./ImageHoverTools";
import type { ImageTarget } from "../imageactions";
import TableToolbar from "./TableToolbar";
import CodeLangPicker from "./CodeLangPicker";
import D2SizeControl from "./D2SizeControl";

/** Caret Range at a viewport point (WebKit caretRangeFromPoint / Firefox fallback). */
function caretRangeAt(x: number, y: number): Range | null {
  const d = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (d.caretRangeFromPoint) return d.caretRangeFromPoint(x, y);
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    if (p) { const r = document.createRange(); r.setStart(p.offsetNode, p.offset); return r; }
  }
  return null;
}

interface Props {
  id: number;
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
  let renderedEl: HTMLDivElement | undefined;
  let pendingCaret: number | null = null;
  let composing = false;
  let lastRevealCaret = -1;

  // Render mermaid/D2 diagrams into the rendered view after each (re)render of
  // an inactive block. renderMarkdown emits empty placeholders; this fills them.
  // Both engines re-render on a theme switch (the shared mermaidEpoch bump).
  createEffect(() => {
    renderEpoch();
    mermaidEpoch();
    void props.text;
    if (props.active) return;
    const host = renderedEl;
    const key = String(props.id);
    if (host) queueMicrotask(() => {
      void renderMermaidIn(host, key);
      void renderD2In(host, key);
    });
  });

  const reveal = (caret: number) => {
    if (!el) return;
    lastRevealCaret = caret;
    // Surface the caret for the status bar's Ln/Col (active block only).
    if (props.active) setLiveCaretOffset(caret);
    applyMarkerVisibility(el, props.text, caret);
  };

  const isFence = () => /^\s*(`{3,}|~{3,})/.test(props.text) || props.text.startsWith("---\n");

  // Code fence (not front matter): expose the language picker while active.
  const isCodeFence = () => /^\s*(`{3,}|~{3,})/.test(props.text);
  const fenceLang = () => props.text.match(/^\s*(?:`{3,}|~{3,})\s*([^\s`]*)/)?.[1] ?? "";
  const setFenceLang = (lang: string) => {
    const lines = props.text.split("\n");
    const head = lines[0].match(/^(\s*(?:`{3,}|~{3,}))/);
    if (!head) return;
    const newFirst = head[1] + lang;
    const delta = newFirst.length - lines[0].length;
    const cur = el ? getCaretOffset(el) : 0;
    const caret = cur > lines[0].length ? cur + delta : Math.min(cur, newFirst.length);
    commit([newFirst, ...lines.slice(1)].join("\n"), Math.max(0, caret));
  };

  // D2 diagram options live in the fence info string (`zoom=NN`, `theme=NN`). A
  // d2 fence is a single block holding one diagram, so the controls govern the
  // whole block. zoom is a percent (100 = unset); theme is a D2 theme id or null.
  const isD2 = () => fenceLang().toLowerCase() === "d2";
  const d2Zoom = () => Number(props.text.match(/(?:^|\s)zoom=(\d{1,3})\b/)?.[1]) || 100;
  const d2Theme = () => props.text.match(/(?:^|\s)theme=(\d{1,3})\b/)?.[1] ?? null;
  const writeD2Opts = (zoom: number, theme: string | null) => {
    const lines = props.text.split("\n");
    const head = lines[0].match(/^(\s*(?:`{3,}|~{3,}))/);
    if (!head) return;
    let info = "d2";
    if (zoom !== 100) info += ` zoom=${zoom}`;
    if (theme != null) info += ` theme=${theme}`;
    commit([head[1] + info, ...lines.slice(1)].join("\n"), 0);
  };
  const setD2Zoom = (percent: number) => writeD2Opts(percent, d2Theme());
  const setD2Theme = (theme: string | null) => writeD2Opts(d2Zoom(), theme);

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
      // preventScroll: focusing a contenteditable otherwise yanks it into
      // view; activation should never move the viewport (find/typewriter
      // scroll deliberately below).
      el.focus({ preventScroll: true });
      // Reveal BEFORE placing the caret: markers at the caret are display:none
      // until revealed, and the browser drops a caret aimed into hidden text to
      // offset 0 (e.g. typing "# " — the whole line is the hidden marker).
      if (selection) {
        reveal(selection.start);
        setSelection(el, selection.start, selection.end);
        el.scrollIntoView({ block: "nearest" });
      } else {
        reveal(caret);
        setCaret(el, caret);
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
      if (k === "z") {
        e.preventDefault();
        return executeCommand(e.shiftKey ? "edit.redo" : "edit.undo");
      }
      if (k === "b") return e.preventDefault(), executeCommand("format.strong");
      if (k === "i") return e.preventDefault(), executeCommand("format.emphasis");
      if (k === "e") return e.preventDefault(), executeCommand("format.code");
      // Shift+Cmd/Ctrl+K inserts a hyperlink; bare Cmd/Ctrl+K is left for the
      // command palette (handled globally in App), so don't preventDefault it.
      if (k === "k" && e.shiftKey) return e.preventDefault(), executeCommand("format.hyperlink");
      if (/^[0-6]$/.test(k)) return e.preventDefault(), executeCommand(`paragraph.heading.${k}`);
      return;
    }
    // Dead-key layouts (many international / "ABC Extended" macOS layouts)
    // treat the backtick/tilde key as a composing dead key, so ``` and ~~~
    // code fences can't be typed. Insert the literal character instead.
    if (e.code === "Backquote" && (e.key === "Dead" || e.key === "Process") && !e.altKey) {
      e.preventDefault();
      insertAtCaret(e.shiftKey ? "~" : "`");
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
    const cd = e.clipboardData;
    if (!cd) return;
    insertAtCaret(
      pasteToInsert({
        html: cd.getData("text/html"),
        plain: cd.getData("text/plain"),
        // Code fences / YAML front matter are literal — keep paste raw there.
        inFence: isFence(),
      }),
    );
  };

  // Hover toolbar anchored to a rendered image's top-right corner. Shown on
  // image hover, kept alive while the pointer is over the toolbar, and hidden
  // on a short delay so moving from image → toolbar doesn't flicker it away.
  const [imgTool, setImgTool] = createSignal<
    { target: ImageTarget; top: number; left: number } | null
  >(null);
  let hideTimer: number | undefined;
  const cancelHide = () => { clearTimeout(hideTimer); hideTimer = undefined; };
  const scheduleHide = () => {
    cancelHide();
    hideTimer = window.setTimeout(() => setImgTool(null), 140);
  };
  onCleanup(cancelHide);

  // Map the <img> under the pointer to its source ImageRef and anchor the
  // toolbar at the image's top-right (inset), positioned within the block.
  const imageRefFor = (img: HTMLImageElement): ImageTarget | null => {
    const imgs = findImages(props.text);
    const ordinal = [...(renderedEl?.querySelectorAll("img") ?? [])].indexOf(img);
    const ref = imgs[ordinal];
    return ref ? { ...ref, blockId: props.id } : null;
  };
  const onRenderedMouseOver = (e: MouseEvent) => {
    const img = (e.target as HTMLElement).closest("img");
    if (!img || !renderedEl?.contains(img) || !rootEl) return;
    const target = imageRefFor(img as HTMLImageElement);
    if (!target) return;
    cancelHide();
    const br = rootEl.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    // Anchor at the image's top-left corner (inset): aligns with the text
    // column, and its menu/fields open rightward into open space.
    setImgTool({ target, top: ir.top - br.top + 8, left: ir.left - br.left + 8 });
  };
  const onRenderedMouseOut = (e: MouseEvent) => {
    const to = e.relatedTarget as HTMLElement | null;
    if (to && (to.closest("img") || to.closest(".img-tools"))) return;
    scheduleHide();
  };

  // Right-click an image in the rendered view → image context menu. The
  // nth <img> maps to the nth image occurrence in this block's source.
  const onRenderedContextMenu = (e: MouseEvent) => {
    const host = e.currentTarget as HTMLElement;
    const img = (e.target as HTMLElement).closest("img");
    if (img && host.contains(img)) {
      const imgs = findImages(props.text);
      const ordinal = [...host.querySelectorAll("img")].indexOf(img as HTMLImageElement);
      const ref = imgs[ordinal];
      if (ref) {
        e.preventDefault();
        e.stopPropagation();
        // WebKit selects the image on right-click; drop that selection so the
        // whole image doesn't flash blue behind the menu.
        window.getSelection()?.removeAllRanges();
        openImageMenu({ ...ref, blockId: props.id }, e.clientX, e.clientY);
        return;
      }
    }
    // Non-image right-click: place a caret (unless text is selected, which we
    // keep) so Paste has a target, then open the editor context menu.
    const sel = window.getSelection();
    const text = sel && !sel.isCollapsed ? sel.toString() : "";
    if (!text.trim()) activateAtPoint(host, e.clientX, e.clientY);
    e.preventDefault();
    e.stopPropagation();
    openEditorMenu(e.clientX, e.clientY, text, !!parseTable(props.text));
  };

  // Right-click inside the active (editable) block keeps the caret/selection.
  const onSourceContextMenu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const sel = window.getSelection();
    openEditorMenu(e.clientX, e.clientY, sel && !sel.isCollapsed ? sel.toString() : "", !!parseTable(props.text));
  };

  // Task-list toggling lives on `click`, not `mousedown`: toggling rewrites the
  // source and re-renders this block, and doing that during mousedown left the
  // browser's native checkbox toggle to fire afterwards on the freshly rendered
  // input — fighting our source-driven state (you could check but not uncheck).
  // Here we cancel the native toggle and drive state from the markdown source.
  const onRenderedCheckboxClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    if (!(t instanceof HTMLInputElement && t.type === "checkbox")) return;
    e.preventDefault();
    const host = e.currentTarget as HTMLElement;
    const boxes = Array.from(host.querySelectorAll('input[type="checkbox"]'));
    props.onToggleTask(boxes.indexOf(t));
  };

  // Map a viewport point inside the rendered block to a source caret offset,
  // then activate the block there.
  const activateAtPoint = (host: HTMLElement, x: number, y: number) => {
    let caret: number | undefined;
    const range = caretRangeAt(x, y);
    if (range && host.contains(range.startContainer)) {
      const pre = range.cloneRange();
      pre.selectNodeContents(host);
      pre.setEnd(range.startContainer, range.startOffset);
      caret = mapRenderedPrefixToSource(props.text, pre.toString());
    }
    props.onActivate(caret);
  };

  // Browse for a file to fill an empty image (![]() ) placeholder's src.
  const fillEmptyImage = async () => {
    const target = findImages(props.text).find((im) => !im.src.trim());
    if (!target) return;
    const path = await pickImageFile();
    if (!path) return;
    const ref = await imageInsertRef(path);
    const dest = /\s/.test(ref) ? `<${ref}>` : ref;
    const markup = target.kind === "html"
      ? `<img src="${dest}" alt="${target.alt}" />`
      : `![${target.alt}](${dest})`;
    props.onChange(props.text.slice(0, target.start) + markup + props.text.slice(target.end));
  };

  const onRenderedClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement;
    // The Browse chip on an empty-image hint opens the file picker.
    if (t.closest("[data-img-browse]")) {
      e.preventDefault();
      void fillEmptyImage();
      return;
    }
    // A checkbox is handled on click. Do NOT preventDefault here: in WebKit (the
    // macOS Tauri webview) preventDefault on a form control's mousedown can
    // suppress the following click, which is where the toggle lives. The early
    // return alone keeps the block from activating.
    if (t instanceof HTMLInputElement && t.type === "checkbox") {
      return;
    }
    const link = t.closest("a");
    if (link?.getAttribute("href") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      openExternal(link.getAttribute("href")!);
      return;
    }
    // Clicking an image no longer drops the block into raw ![](…) source — the
    // hover toolbar owns image edits. Leave surrounding text clickable so the
    // rest of the paragraph still enters edit mode normally.
    if (t.closest("img")) { e.preventDefault(); return; }
    if (e.button !== 0) return;
    // Defer activation until mouseup: a plain click enters the block for editing,
    // but a drag is left alone so the browser can extend a native selection
    // across sibling (rendered) blocks instead of trapping it in this one once
    // it turns into the sole contenteditable host.
    const host = e.currentTarget as HTMLElement;
    const sx = e.clientX;
    const sy = e.clientY;
    let dragged = false;
    const onMove = (m: MouseEvent) => {
      if (Math.abs(m.clientX - sx) + Math.abs(m.clientY - sy) > 4) dragged = true;
    };
    const onUp = (u: MouseEvent) => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const sel = window.getSelection();
      // A drag (or any resulting non-empty selection) stays as a selection.
      if (dragged || (sel && !sel.isCollapsed)) return;
      activateAtPoint(host, u.clientX, u.clientY);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Drag-select starting inside the active (contenteditable) block: a native
  // selection is trapped in this editing host, so once the drag crosses into
  // another block, deactivate this one (every block becomes a plain rendered
  // node) and drive the cross-block selection manually from the start point.
  const onSourceMouseDown = (e: MouseEvent) => {
    if (e.button !== 0) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const thisBlock = rootEl;
    let anchor: { node: Node; offset: number } | null = null;
    let switched = false;
    const extendTo = (x: number, y: number) => {
      const f = caretRangeAt(x, y);
      const sel = window.getSelection();
      if (anchor && f && sel) sel.setBaseAndExtent(anchor.node, anchor.offset, f.startContainer, f.startOffset);
    };
    const onMove = (m: MouseEvent) => {
      if (switched) { extendTo(m.clientX, m.clientY); return; }
      const over = (document.elementFromPoint(m.clientX, m.clientY) as HTMLElement | null)?.closest(".block");
      if (over && over !== thisBlock) {
        switched = true;
        props.onDeactivate(); // → all blocks rendered; re-render lands next frame
        requestAnimationFrame(() => {
          const a = caretRangeAt(startX, startY);
          anchor = a ? { node: a.startContainer, offset: a.startOffset } : null;
          extendTo(m.clientX, m.clientY);
        });
      }
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  return (
    <div class="block" classList={{ active: props.active }} ref={rootEl}>
      <Show when={props.active && parseTable(props.text)}>
        <TableToolbar text={props.text} />
      </Show>
      <Show when={props.active && isCodeFence()}>
        <CodeLangPicker current={fenceLang()} onSelect={setFenceLang} onCancel={() => el?.focus()} />
      </Show>
      <Show
        when={props.active}
        fallback={
          <>
            <div
              class="rendered"
              ref={renderedEl}
              onMouseDown={onRenderedClick}
              onClick={onRenderedCheckboxClick}
              onContextMenu={onRenderedContextMenu}
              onMouseOver={onRenderedMouseOver}
              onMouseOut={onRenderedMouseOut}
              // eslint-disable-next-line solid/no-innerhtml -- renderMarkdown output is DOMPurify-sanitized
              innerHTML={(renderEpoch(), mermaidEpoch(), renderMarkdown(props.text, String(props.id)))}
            />
            <Show when={imgTool()}>
              {(it) => (
                <ImageHoverTools
                  target={it().target}
                  top={it().top}
                  left={it().left}
                  onEnter={cancelHide}
                  onLeave={scheduleHide}
                  onClose={() => setImgTool(null)}
                  onShowSource={() => {
                    const start = it().target.start;
                    setImgTool(null);
                    props.onActivate(start);
                  }}
                />
              )}
            </Show>
            <Show when={isD2()}>
              <D2SizeControl
                zoom={d2Zoom()}
                onZoom={setD2Zoom}
                theme={d2Theme()}
                onTheme={setD2Theme}
              />
            </Show>
          </>
        }
      >
        <div
          ref={el}
          class={`source ${blockType()}`}
          classList={{ "code-block": isFence() }}
          contentEditable={true}
          spellcheck={spellcheckOn()}
          onMouseDown={onSourceMouseDown}
          onInput={onInput}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onContextMenu={onSourceContextMenu}
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
