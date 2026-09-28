import { Show, createEffect, createMemo, createSignal, on, onCleanup, untrack } from "solid-js";
import { complexBlockKind } from "../complexblocks";
import { renderMarkdown, hasOpenFence } from "../markdown";
import {
  styleSource, stylePanelSource, hydrateInlinePreviews, hasSourceLayout, getCaretOffset, getSelectionOffsets, setCaret, setSelection,
  applyMarkerVisibility, mapRenderedPrefixToSource,
} from "../livesource";
import { isTauri, pickImageFile } from "../platform";
import {
  consumeCaretRequest, consumeSelectionRequest,
  spellcheckOn, smartPunctuation, renderEpoch, mermaidEpoch, mathFence, mathAltDelimiters,
  setLiveCaretOffset, renderContext,
} from "../store";
import { renderMermaidIn } from "../mermaid";
import { renderD2In } from "../d2";
import { executeCommand, registerBlockApi, unregisterBlockApi, imageInsertRef, followLink, type BlockApi } from "../commands";
import { parseTable, cellRanges } from "../tabletools";
import { findImages } from "../images";
import { pasteToInsert } from "../richpaste";
import { openImageMenu } from "./ImageContextMenu";
import { openEditorMenu } from "./EditorContextMenu";
import ImageHoverTools from "./ImageHoverTools";
import ImageProperties from "./ImageProperties";
import LinkHoverTools from "./LinkHoverTools";
import type { ImageTarget } from "../imageactions";
import { linkForHref, type LinkTarget } from "../links";
import TableToolbar from "./TableToolbar";
import TableReorder from "./TableReorder";
import TableRails from "./TableRails";
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

/**
 * Rendered HTML per block id, reused while the block's render key is
 * unchanged. Tab switches remount every block of the incoming document;
 * block ids survive the switch, so this turns a full re-render into string
 * lookups. Mermaid/D2 SVGs are cached separately by source.
 */
const htmlCache = new Map<number, { key: string; html: string }>();

export default function Block(props: Props) {
  let el: HTMLDivElement | undefined;
  let rootEl: HTMLDivElement | undefined;
  let renderedEl: HTMLDivElement | undefined;
  let pendingCaret: number | null = null;
  let composing = false;
  let lastRevealCaret = -1;
  const [panelKind, setPanelKind] = createSignal<string | null>(null);
  let panelEl: HTMLDivElement | undefined;
  // "Mermaid diagram", "D2 diagram", "Equation", "Metadata"…
  const DIAGRAM_NAMES: Record<string, string> = { mermaid: "Mermaid", d2: "D2", sequence: "Sequence", flow: "Flowchart" };
  const panelTitle = () => {
    const kind = panelKind();
    if (kind !== "Diagram") return kind ?? "";
    const lang = props.text.match(/^\s*(?:`{3,}|~{3,})\s*(\w+)/)?.[1]?.toLowerCase() ?? "";
    return `${DIAGRAM_NAMES[lang] ?? "Diagram"} diagram`;
  };
  // What the preview does as the source changes, per kind.
  const panelHint = () => {
    switch (panelKind()) {
      case "Table of contents": return "Built from the document's headings";
      case "Metadata": return "YAML front matter";
      default: return "Preview updates as you type";
    }
  };
  // The card opens below its preview; bring it into view if that is below the
  // fold (scrolling moves the viewport, never the layout).
  createEffect(on(panelKind, (kind) => {
    if (!kind) return;
    requestAnimationFrame(() => panelEl?.scrollIntoView({
      block: "nearest",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    }));
  }, { defer: true }));
  // Keep the editor mode stable while an opening delimiter is temporarily incomplete.
  createEffect(on(() => props.active, active => setPanelKind(active ? complexBlockKind(props.text, { mathFence: mathFence(), alternateMath: mathAltDelimiters() }) : null)));


  // Everything this block's rendered HTML depends on: its text, the global
  // render options, and the slice of document context it uses (see
  // buildRenderContext). Edits elsewhere leave the key, and the DOM, untouched.
  const contextSig = createMemo(() => renderContext().blocks.get(String(props.id))?.sig ?? "");
  // Diagram SVGs bake in theme colours; everything else follows CSS variables,
  // so only diagram blocks re-render on a theme switch.
  const hasDiagram = () => /^[ \t>]*(?:`{3,}|~{3,})[ \t]*(?:mermaid|d2|sequence|flow)\b/im.test(props.text);
  // While a diagram's source is open, its preview follows the text after a
  // short pause rather than on every keystroke: each layout is expensive, and
  // the previous diagram stays on screen meanwhile (see renderMermaidIn).
  const [settledText, setSettledText] = createSignal(untrack(() => props.text));
  createEffect(() => {
    const text = props.text;
    if (panelKind() !== "Diagram") return setSettledText(text);
    const timer = setTimeout(() => setSettledText(text), 250);
    onCleanup(() => clearTimeout(timer));
  });
  const previewText = () => (panelKind() === "Diagram" ? settledText() : props.text);
  const renderKey = createMemo(() =>
    `${renderEpoch()}\u0002${hasDiagram() ? mermaidEpoch() : ""}\u0002${contextSig()}\u0002${previewText()}`);
  const renderedHtml = () => {
    const key = renderKey();
    const hit = htmlCache.get(props.id);
    if (hit?.key === key) return hit.html;
    const html = untrack(() => renderMarkdown(previewText(), String(props.id)));
    if (htmlCache.size > 5000) htmlCache.clear();
    htmlCache.set(props.id, { key, html });
    return html;
  };

  // Fill mermaid/D2 placeholders in a rendered view. renderMarkdown emits them
  // empty; each preview element schedules its own fill when it mounts (see
  // bindRendered) and again whenever its HTML is re-rendered. Driving it from
  // the element itself matters: an effect holding a shared ref could fire
  // before the source panel's preview existed and leave it blank for good.
  // eslint-disable-next-line solid/reactivity -- a Block's id never changes
  const fillDiagrams = (host: HTMLElement) => queueMicrotask(() => {
    if (!host.isConnected) return;
    void renderMermaidIn(host, String(props.id), true);
    void renderD2In(host, String(props.id));
  });
  const bindRendered = (host: HTMLDivElement) => {
    renderedEl = host;
    fillDiagrams(host);
  };
  createEffect(on(renderKey, () => { if (renderedEl) fillDiagrams(renderedEl); }, { defer: true }));

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
    if (hasSourceLayout(t)) return "b-layout";
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
    // contextSig: re-style when this block's own document context or lazily
    // loaded render data changes (not on every global asset arrival).
    on([() => props.active, () => props.text, renderEpoch, panelKind, contextSig], ([active, text], previous) => {
      if (!active || !el || composing) return;
      // Shiki can finish loading while a list is active. Refresh its code
      // colors without moving the user's caret or losing a text selection.
      const current = previous?.[0] && previous[1] === text && el.contains(window.getSelection()?.anchorNode ?? null)
        ? getSelectionOffsets(el) : null;
      const selection = consumeSelectionRequest() ?? (current && current.start !== current.end ? current : null);
      const caret = pendingCaret ?? consumeCaretRequest() ?? current?.start ?? props.text.length;
      pendingCaret = null;
      el.innerHTML = panelKind() ? stylePanelSource(props.text) : styleSource(props.text);
      hydrateInlinePreviews(el, source => renderMarkdown(source, String(props.id)), offset => {
        if (!el) return;
        el.focus({ preventScroll: true }); reveal(offset); setCaret(el, offset);
      });
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
    const cont = line.match(/^(\s*)([-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|(?:>\s*)+)/);
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
      const num = marker.match(/^(\s*)(\d+)([.)])(\s+)$/);
      if (num) marker = `${num[1]}${Number(num[2]) + 1}${num[3]}${num[4]}`;
      if (marker.match(/\[[xX]\]/)) marker = marker.replace(/\[[xX]\]/, "[ ]");
      insertAtCaret("\n" + marker);
      return;
    }
    // Plain paragraph: finalize this block, continue in a fresh one.
    props.onSplit(t.slice(0, offset), t.slice(offset));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (composing) return;
    if (panelKind()) {
      if (e.key === "Escape") { e.preventDefault(); props.onDeactivate(); rootEl?.closest<HTMLElement>(".editor")?.focus({ preventScroll: true }); return; }
      if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) { e.preventDefault(); insertAtCaret("\n"); return; }
      if (e.key === "Tab") { if (!e.shiftKey) { e.preventDefault(); insertAtCaret("  "); } return; }
      if ((e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "Backspace" || e.key === "Delete") && !e.altKey && !e.metaKey && !e.ctrlKey) return;
    }
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
    if (e.key === "Escape") { e.preventDefault(); el?.closest<HTMLElement>(".editor")?.focus({ preventScroll: true }); el?.blur(); return; }
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
      const line = rect.height || parseFloat(cs.lineHeight) || 24;
      // Measure against the content's own first/last line boxes: layout blocks
      // (headings, lists, quotes) carry margins inside the editable host, so
      // its padding edge sits well above the first line.
      const all = document.createRange();
      all.selectNodeContents(el);
      const lines = [...all.getClientRects()].filter((r) => r.height > 0);
      const host = el.getBoundingClientRect();
      const top = lines.length ? Math.min(...lines.map((r) => r.top)) : host.top + parseFloat(cs.paddingTop);
      const bottom = lines.length ? Math.max(...lines.map((r) => r.bottom)) : host.bottom - parseFloat(cs.paddingBottom);
      if (e.key === "ArrowUp") {
        if (rect.top - top < line * 0.5) { e.preventDefault(); props.onNavigate(-1); }
      } else if (bottom - rect.bottom < line * 0.5) { e.preventDefault(); props.onNavigate(1); }
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
    {
      target: ImageTarget; ordinal: number; top: number; left: number;
      /** Intrinsic pixel size, so the properties panel can bound its size
       *  slider and offer "back to natural" rather than guessing. */
      natural: { w: number; h: number };
      /** Already-resolved URL of the rendered image, so the panel can show a
       *  thumbnail without re-running the asset-protocol path resolution. */
      resolvedSrc: string;
    } | null
  >(null);
  // Swaps the hover toolbar for the full Image Properties panel. The panel is
  // a click-to-open surface, so it ignores the hover-out timer.
  const [imgProps, setImgProps] = createSignal(false);
  let hideTimer: number | undefined;
  const cancelHide = () => { clearTimeout(hideTimer); hideTimer = undefined; };
  const scheduleHide = () => {
    cancelHide();
    if (imgProps()) return;
    hideTimer = window.setTimeout(() => setImgTool(null), 140);
  };
  onCleanup(cancelHide);

  // Same hover model as images, but resolved by href rather than ordinal: the
  // renderer emits anchors with no link behind them (footnote refs, [TOC]), so
  // counting anchors would drift off the source.
  const [linkTool, setLinkTool] = createSignal<
    { target: LinkTarget; top: number; left: number } | null
  >(null);
  /**
   * Hover intent. Text is full of links, and a helper that appears the instant
   * the pointer crosses one flickers on every sweep of the mouse. So it waits
   * for the pointer to *rest* — and leaves the moment you go elsewhere, since
   * a lingering popover over prose is worse than a slow one.
   *
   * Nothing is needed to bridge the gap to the card: the card's wrapper starts
   * flush against the link and pads itself down, so travelling into it never
   * crosses dead space (see .link-tools / .lht-card).
   */
  const LINK_HOVER_MS = 380;
  let linkShowTimer: number | undefined;
  const cancelLinkShow = () => { clearTimeout(linkShowTimer); linkShowTimer = undefined; };
  const showLinkAfterRest = (state: { target: LinkTarget; top: number; left: number }) => {
    cancelLinkShow();
    // Already open on this same link — keep it, don't re-animate.
    if (linkTool()?.target.start === state.target.start) return;
    // A different link: drop the open card now rather than leaving it pointing
    // at the link you just left for the length of the hover delay.
    if (linkTool()) setLinkTool(null);
    linkShowTimer = window.setTimeout(() => setLinkTool(state), LINK_HOVER_MS);
  };
  const hideLinkNow = () => {
    cancelLinkShow();
    setLinkTool(null);
  };
  onCleanup(cancelLinkShow);

  /**
   * Re-resolve an image occurrence against the block's current text. Committing
   * a property rewrites the source, which shifts every offset after it, so the
   * ImageTarget captured on hover is stale from the first edit onward. The
   * image's ordinal within the block is what stays put, so that is the key.
   */
  const imageAt = (ordinal: number): ImageTarget | null => {
    const ref = findImages(props.text)[ordinal];
    return ref ? { ...ref, blockId: props.id } : null;
  };

  // Map the <img> under the pointer to its source ImageRef and anchor the
  // toolbar at the image's top-right (inset), positioned within the block.
  const ordinalOf = (img: HTMLImageElement) =>
    [...(renderedEl?.querySelectorAll("img") ?? [])].indexOf(img);
  const onRenderedMouseOver = (e: MouseEvent) => {
    const anchor = (e.target as HTMLElement).closest("a");
    if (anchor && renderedEl?.contains(anchor) && rootEl && !imgProps()) {
      const href = anchor.getAttribute("href") ?? "";
      // Which occurrence of this href is it? Repeated links to one URL still
      // resolve to the right span.
      const same = [...renderedEl.querySelectorAll("a")].filter(
        (a) => a.getAttribute("href") === href,
      );
      const ref = href ? linkForHref(props.text, href, same.indexOf(anchor)) : null;
      if (ref) {
        const br = rootEl.getBoundingClientRect();
        const ar = anchor.getBoundingClientRect();
        showLinkAfterRest({
          target: { ...ref, blockId: props.id },
          // Flush to the link's underside; the card pads itself away, so the
          // pointer can travel into it without leaving the element.
          top: ar.bottom - br.top,
          left: ar.left - br.left,
        });
        return;
      }
    }
    const img = (e.target as HTMLElement).closest("img");
    if (!img || !renderedEl?.contains(img) || !rootEl) return;
    if (imgProps()) return; // the properties panel owns the surface
    const ordinal = ordinalOf(img as HTMLImageElement);
    const target = imageAt(ordinal);
    if (!target) return;
    cancelHide();
    const br = rootEl.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    // Anchor at the image's top-left corner (inset): aligns with the text
    // column, and its menu/fields open rightward into open space.
    const el = img as HTMLImageElement;
    setImgTool({
      target,
      ordinal,
      natural: { w: el.naturalWidth || 0, h: el.naturalHeight || 0 },
      resolvedSrc: el.currentSrc || el.src,
      top: ir.top - br.top + 8,
      left: ir.left - br.left + 8,
    });
  };
  const onRenderedMouseOut = (e: MouseEvent) => {
    const to = e.relatedTarget as HTMLElement | null;
    // Every hold-open test below is scoped to *this* block. A link or a hover
    // card belonging to a neighbouring block is somewhere else as far as this
    // one is concerned: keeping our helper alive for it would strand it, since
    // the next mouseout arrives on that block, not here.
    const inBlock = !!to && !!rootEl?.contains(to);
    if (inBlock && (to!.closest("a") || to!.closest(".link-tools"))) return;
    hideLinkNow();
    if (inBlock && (to!.closest("img") || to!.closest(".img-tools") || to!.closest(".img-props")))
      return;
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
      const fragment = pre.cloneContents();
      // KaTeX includes both MathML and visual text. Map the original formula
      // once so clicks after an equation cannot drift past the intended word.
      fragment.querySelectorAll<HTMLElement>("[data-math-source]").forEach(math => math.replaceWith(document.createTextNode(math.dataset.mathSource ?? "")));
      caret = mapRenderedPrefixToSource(props.text, fragment.textContent ?? "");
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
    const diagramLink = t.closest("a[data-diagram-link]");
    if (diagramLink?.getAttribute("href")) { e.preventDefault(); void followLink(diagramLink.getAttribute("href")!); return; }
    const link = t.closest("a");
    if (link?.getAttribute("href") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void followLink(link.getAttribute("href")!);
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
        <TableRails text={props.text} />
        <TableReorder text={props.text} onMove={commit} />
      </Show>
      <Show when={props.active && isCodeFence() && !panelKind()}>
        <CodeLangPicker current={fenceLang()} onSelect={setFenceLang} onCancel={() => el?.focus()} />
      </Show>
      <Show
        when={props.active}
        fallback={
          <>
            <div
              class="rendered"
              ref={bindRendered}
              onMouseDown={onRenderedClick}
              onClick={onRenderedCheckboxClick}
              onContextMenu={onRenderedContextMenu}
              onMouseOver={onRenderedMouseOver}
              onMouseOut={onRenderedMouseOut}
              // eslint-disable-next-line solid/no-innerhtml -- renderMarkdown output is DOMPurify-sanitized
              innerHTML={renderedHtml()}
            />
            <Show when={imgTool()}>
              {(it) => (
                <Show
                  when={!imgProps()}
                  fallback={
                    <ImageProperties
                      // Re-read the occurrence from the live block text: a
                      // committed edit rewrites the source, so the target
                      // captured on hover is stale by the next keystroke.
                      target={imageAt(it().ordinal) ?? it().target}
                      natural={it().natural}
                      preview={it().resolvedSrc}
                      top={it().top}
                      left={it().left}
                      onEnter={cancelHide}
                      onLeave={scheduleHide}
                      onClose={() => { setImgProps(false); setImgTool(null); }}
                    />
                  }
                >
                  <ImageHoverTools
                    target={it().target}
                    top={it().top}
                    left={it().left}
                    onEnter={cancelHide}
                    onLeave={scheduleHide}
                    onClose={() => setImgTool(null)}
                    onProperties={() => setImgProps(true)}
                    onShowSource={() => {
                      const start = it().target.start;
                      setImgTool(null);
                      props.onActivate(start);
                    }}
                  />
                </Show>
              )}
            </Show>
            <Show when={linkTool()}>
              {(lt) => (
                <LinkHoverTools
                  target={lt().target}
                  top={lt().top}
                  left={lt().left}
                  onEnter={cancelLinkShow}
                  onLeave={hideLinkNow}
                  onClose={hideLinkNow}
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
        <Show when={panelKind()}>
          <div class="rendered" ref={bindRendered}
            // eslint-disable-next-line solid/no-innerhtml -- shared sanitized renderer
            innerHTML={renderedHtml()} />
        </Show>
        <div ref={panelEl} class="source-container" classList={{ "block-source-panel": !!panelKind() }} role={panelKind() ? "region" : undefined} aria-label={panelKind() ? `${panelTitle()} source editor` : undefined}>
          <Show when={panelKind()}>
            <div class="block-source-panel-header">
              <span>{panelTitle()}</span>
              <Show when={panelHint()}><span class="block-source-panel-hint">{panelHint()}</span></Show>
              <button type="button" onClick={() => { props.onDeactivate(); rootEl?.closest<HTMLElement>(".editor")?.focus({ preventScroll: true }); }}>Done <kbd>Esc</kbd></button>
            </div>
          </Show>
        <div
          ref={el}
          class={`source ${blockType()}`}
          classList={{ "code-block": isFence() || !!panelKind() }}
          contentEditable={true}
          role="textbox" aria-multiline="true" aria-label={panelKind() ? `Edit ${panelKind()?.toLowerCase()} source` : "Edit Markdown block"}
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
        </div>
      </Show>
    </div>
  );
}
