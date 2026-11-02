/**
 * The web build's document bar. A browser already has a menu bar, so the app
 * doesn't draw a second one: the everyday commands sit in the toolbar, one Menu
 * holds the rest, and the palette lists everything. On a touch screen the Menu
 * is a full-height sheet, because hover flyouts can't work there.
 *
 * Commands stay in `src/menudata.ts`; this file only chooses which to show.
 * Evaluate it only after the platform is installed (see main.ts).
 */
import { For, Show, createEffect, createSignal, on, onCleanup, onMount, type JSX } from "solid-js";
import { executeCommand, holdEditing } from "../../../src/commands";
import ModalFrame from "../../../src/components/ModalFrame";
import { MenuList } from "../../../src/components/MenuBar";
import { MENU_ICONS, ICONS } from "../../../src/menuicons";
import { blockTargetsEnabled, BLOCK_TARGETED_IDS, findLeaf, type MenuLeaf, type MenuNode } from "../../../src/menudata";
import { activeTabId, doc, fileName, openTabs, readTime, setSidebarOpen, sidebarOpen, sourceMode, stats, switchTab } from "../../../src/store";

/** Commands from the tree, in this order; "-" is a separator. */
const pick = (...ids: string[]): MenuNode[] => ids.flatMap((id): MenuNode[] => {
  if (id === "-") return [{ sep: true }];
  const leaf = findLeaf(id);
  return leaf ? [leaf] : [];
});
const named = (id: string, label: string): MenuNode[] => {
  const leaf = findLeaf(id);
  return leaf ? [{ ...leaf, label, items: undefined }] : [];
};

const EXPORT_ITEMS: MenuNode[] = [
  ...named("file.export.pdf", "PDF or Print…"), ...named("file.export.docx", "Word"), ...named("file.export.html", "HTML"),
  ...named("web.download_markdown", "Markdown"), { sep: true },
  ...pick("file.export.html_plain", "file.export.odt", "file.export.rtf", "file.export.epub", "file.export.latex",
    "file.export.mediawiki", "file.export.rst", "file.export.textile", "file.export.opml"),
];

const canPick = "showOpenFilePicker" in window;
const submenu = (label: string, items: MenuNode[]): MenuLeaf => ({ id: `menu.${label.toLowerCase()}`, label, items });

const MENU_ITEMS: MenuNode[] = [
  ...named("file.new", "New Document"),
  // Without the browser's file access, opening a file brings in a copy.
  ...named("file.open", canPick ? "Open…" : "Open a Copy…"),
  ...pick("file.open_quickly"),
  ...named("file.open_folder", "Add a Folder…"),
  { sep: true },
  ...pick("file.save"),
  ...named("file.rename", "Rename or Move…"), ...named("file.save_as", "Duplicate…"),
  ...pick("file.delete"),
  { sep: true },
  ...pick("file.import"),
  submenu("Export", EXPORT_ITEMS),
  { sep: true },
  submenu("Edit", pick(
    "edit.undo", "edit.redo", "-", "edit.find", "edit.find_next", "edit.replace", "view.search", "-",
    "edit.copy_markdown", "edit.copy_html", "edit.paste_plain", "-", "edit.spellcheck",
  )),
  submenu("Blocks", pick(
    "paragraph.heading.1", "paragraph.heading.2", "paragraph.heading.3", "paragraph.heading.0", "-",
    "paragraph.unordered_list", "paragraph.ordered_list", "paragraph.task_list", "paragraph.quote", "-",
    "paragraph.table.insert", "paragraph.code_fences", "paragraph.math_block", "paragraph.hr", "-",
    "paragraph.toc", "paragraph.footnote", "paragraph.front_matter",
  )),
  submenu("Format", pick(
    "format.strong", "format.emphasis", "format.underline", "format.strike", "format.code", "format.inline_math",
    "format.comment", "-", "format.hyperlink", "format.image.insert", "-", "format.clear",
  )),
  submenu("View", [
    ...pick("view.source_mode", "view.focus_mode", "view.typewriter_mode", "-", "view.sidebar", "view.status_bar", "-",
      "view.zoom_actual", "view.zoom_in", "view.zoom_out", "view.fullscreen"),
    { id: "themes.picker", label: "Themes…" },
  ]),
  { sep: true },
  ...named("web.backup", "Back Up Library…"),
  ...pick("app.settings"),
  ...named("help.about", "About Sarala"),
];

const media = (query: string) => {
  const list = matchMedia(query);
  const [matches, set] = createSignal(list.matches);
  list.addEventListener("change", (e) => set(e.matches));
  return matches;
};

/** A phone, or any touch screen, where a hover menu can't work. */
const touchMenu = media("(max-width: 640px), (pointer: coarse)");
const phone = media("(max-width: 640px)");

function Icon(props: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
      aria-hidden="true" ref={(el) => (el.innerHTML = ICONS[props.name] ?? props.name)} />
  );
}

const MENU_ICON = '<path d="M4 6h16M4 12h16M4 18h16"/>';
const CHEVRON = '<path d="m9 6 6 6-6 6"/>';
const BACK = '<path d="m15 6-6 6 6 6"/>';
const CLOSE = '<path d="m6 6 12 12M18 6 6 18"/>';

const run = (id: string) => executeCommand(id);
/** Don't take focus from the block, or block commands lose their target. */
const keepFocus = (e: MouseEvent | PointerEvent) => e.preventDefault();

/* ---------- save state ---------- */

/** Says where the document is, because in a browser that isn't obvious. */
function saveState(): { long: string; short: string; title: string } {
  const path = doc.filePath;
  if (!path) return { long: "Draft", short: "Draft", title: "Not saved to a file yet. It stays here across reloads. Click to save." };
  if (doc.dirty) return { long: "Edited", short: "Edited", title: "Click to save your changes" };
  if (path.startsWith("/Downloads")) return { long: "Downloaded", short: "Saved", title: "Saved to your downloads" };
  return path.startsWith("/Library")
    ? { long: "Saved in this browser", short: "Saved", title: "Saved in this browser's storage. Back up the library to keep a copy." }
    : { long: "Saved to device", short: "Saved", title: "Saved to the file on this device" };
}
const clean = () => !doc.dirty && !!doc.filePath;

/* ---------- dropdowns (mouse and keyboard) ---------- */

function Dropdown(props: { class: string; label: string; icon: string; items: MenuNode[]; title: string; onTouch?: () => void }) {
  const [open, setOpen] = createSignal(false);
  let root!: HTMLDivElement;
  let button!: HTMLButtonElement;
  const close = () => setOpen(false);

  onMount(() => {
    const away = (e: MouseEvent) => { if (!root.contains(e.target as Node)) close(); };
    // A menu opened with the mouse leaves focus in the block, outside this one.
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("mousedown", away, true);
    window.addEventListener("keydown", escape);
    onCleanup(() => {
      window.removeEventListener("mousedown", away, true);
      window.removeEventListener("keydown", escape);
    });
  });

  const rows = (from: Element) => [...(from.closest(".menu-dropdown") ?? root).querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled), :scope > .menu-sub > button:not(:disabled)")];
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open()) {
      e.preventDefault(); e.stopPropagation(); close(); button.focus();
      return;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const current = document.activeElement;
    if (current === button) {
      setOpen(true);
      queueMicrotask(() => root.querySelector<HTMLButtonElement>(".menu-dropdown button:not(:disabled)")?.focus());
      return;
    }
    const list = rows(current!);
    const at = list.indexOf(current as HTMLButtonElement);
    list[(at + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
  };

  return (
    <div class={`web-dropdown ${props.class}`} ref={root} onKeyDown={onKeyDown} onMouseDown={keepFocus}
      onClick={(e) => { if ((e.target as Element).closest(".menu-item:not(.menu-parent)")) close(); }}>
      <button ref={button} class="web-bar-btn" aria-haspopup={props.onTouch ? "dialog" : "true"} aria-expanded={open()} title={props.title}
        onClick={() => (props.onTouch && touchMenu() ? props.onTouch() : setOpen(!open()))}>
        <Icon name={props.icon} /><span class="web-bar-label">{props.label}</span>
      </button>
      <Show when={open()}><MenuList items={props.items} /></Show>
    </div>
  );
}

/* ---------- the sheet (touch) ---------- */

const [sheet, setSheet] = createSignal<null | { title: string; items: MenuNode[] }[]>(null);
let returnToBlock = () => {};

function openSheet(start?: { title: string; items: MenuNode[] }) {
  returnToBlock = holdEditing();
  setSheet([{ title: "Menu", items: MENU_ITEMS }, ...(start ? [start] : [])]);
}

function Sheet() {
  const view = () => sheet()!.at(-1)!;
  const close = () => setSheet(null);
  const back = () => setSheet((v) => v!.slice(0, -1));
  const disabled = (n: MenuLeaf) => (n.enabled ? !n.enabled() : !!n.id && BLOCK_TARGETED_IDS.has(n.id) && !blockTargetsEnabled());
  const choose = (n: MenuLeaf) => {
    close();
    // A block command needs its block back first. Anything else must run now:
    // a file picker only opens in the same turn as the tap.
    if (/^(format|paragraph)\./.test(n.id!)) {
      returnToBlock();
      requestAnimationFrame(() => run(n.id!));
    } else run(n.id!);
  };
  return (
    <div class="web-sheet-scrim" onClick={(e) => e.target === e.currentTarget && close()}>
      <ModalFrame class="web-sheet" label={view().title} onClose={close}>
        <header class="web-sheet-head">
          <Show when={sheet()!.length > 1} fallback={<span class="web-sheet-gap" />}>
            <button class="web-sheet-icon" aria-label="Back" onClick={back}><Icon name={BACK} /></button>
          </Show>
          <h2>{view().title}</h2>
          <button class="web-sheet-icon" aria-label="Close" onClick={close}><Icon name={CLOSE} /></button>
        </header>
        <div class="web-sheet-body">
          <Show when={sheet()!.length === 1}>
            <p class="web-sheet-summary">{stats().words} words, {readTime()} min read</p>
          </Show>
          <Show when={sheet()!.length > 1 && !blockTargetsEnabled() && view().items.some((n) => "id" in n && /^(format|paragraph)\./.test(n.id ?? ""))}>
            <p class="web-sheet-summary">Tap a paragraph first, then come back here.</p>
          </Show>
          <Show when={sheet()!.length === 1 && openTabs().length > 1}>
            <h3>Open documents</h3>
            <For each={openTabs()}>{(tab) => (
              <button class="web-sheet-row" aria-current={tab.id === activeTabId() ? "page" : undefined}
                onClick={() => { close(); switchTab(tab.id); }}>
                <span class="web-sheet-ic"><Icon name="file" /></span><span>{tab.name}</span>
              </button>
            )}</For>
            <h3>Menu</h3>
          </Show>
          <For each={view().items}>{(n) => {
            if ("sep" in n) return <hr />;
            if ("dynamic" in n) return null;
            return n.items
              ? (
                <button class="web-sheet-row" onClick={() => setSheet((v) => [...v!, { title: n.label, items: n.items! }])}>
                  <span class="web-sheet-ic"><Icon name={MENU_ICONS[n.id ?? ""] ?? ""} /></span>
                  <span>{n.label}</span><span class="web-sheet-end"><Icon name={CHEVRON} /></span>
                </button>
              )
              : (
                <button class="web-sheet-row" disabled={disabled(n)} aria-pressed={n.type ? !!n.checked?.() : undefined} onClick={() => choose(n)}>
                  <span class="web-sheet-ic"><Icon name={MENU_ICONS[n.id ?? ""] ?? ""} /></span>
                  <span>{n.label}</span>
                  <Show when={n.checked?.()}><span class="web-sheet-end">✓</span></Show>
                </button>
              );
          }}</For>
        </div>
      </ModalFrame>
    </div>
  );
}

/* ---------- the bar above a phone's keyboard ---------- */

function KeyBar() {
  let el!: HTMLDivElement;
  const coarse = media("(pointer: coarse)");
  const shown = () => phone() && coarse() && doc.activeIndex >= 0 && !sourceMode();

  // The layout viewport ignores the on-screen keyboard; the visual one doesn't.
  onMount(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const place = () => { el.style.bottom = `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`; };
    vv.addEventListener("resize", place);
    vv.addEventListener("scroll", place);
    place();
    onCleanup(() => { vv.removeEventListener("resize", place); vv.removeEventListener("scroll", place); });
  });
  createEffect(() => document.querySelector(".app")?.classList.toggle("web-keybar-on", shown()));

  const key = (label: string, icon: string, act: () => void) => (
    <button aria-label={label} title={label} onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={act}><Icon name={icon} /></button>
  );
  const blocks = () => (MENU_ITEMS.find((n) => "label" in n && n.label === "Blocks") as MenuLeaf);
  return (
    <div ref={el} class="web-keybar" role="toolbar" aria-label="Formatting" hidden={!shown()}>
      <div class="web-keybar-scroll">
        {key("Undo", "undo", () => run("edit.undo"))}
        {key("Heading", "h2", () => run("paragraph.heading.2"))}
        {key("Bold", "bold", () => run("format.strong"))}
        {key("Italic", "italic", () => run("format.emphasis"))}
        {key("Bullet list", "list", () => run("paragraph.unordered_list"))}
        {key("Task list", "check", () => run("paragraph.task_list"))}
        {key("Link", "link", () => run("format.hyperlink"))}
        {key("Quote", "quote", () => run("paragraph.quote"))}
        {key("Insert block", "paragraph", () => openSheet({ title: "Blocks", items: blocks().items! }))}
      </div>
      <button class="web-keybar-more" aria-label="More" onPointerDown={keepFocus} onMouseDown={keepFocus} onClick={() => openSheet()}><Icon name={MENU_ICON} /></button>
    </div>
  );
}

/* ---------- the pieces ---------- */

function Start() {
  return <Dropdown class="web-menu" label="Menu" icon={MENU_ICON} title="Menu" items={MENU_ITEMS} onTouch={() => openSheet()} />;
}

function AfterTabs() {
  return (
    <>
      <button class="web-docname" title="Rename" onClick={() => run("file.rename")}>
        <span class="web-docname-name">{fileName()}</span>
        <span class="web-docname-state" classList={{ dirty: !clean() }} aria-live="polite">{saveState().short}</span>
      </button>
      <button class="web-save" classList={{ dirty: !clean() }} disabled={clean()} title={saveState().title} aria-live="polite"
        onMouseDown={keepFocus} onClick={() => run("file.save")}>
        {saveState().long}
      </button>
    </>
  );
}

function Actions() {
  return (
    <span class="web-history">
      <button class="topbar-toggle icon-btn" title="Undo" aria-label="Undo" onMouseDown={keepFocus} onClick={() => run("edit.undo")}><Icon name="undo" /></button>
      <button class="topbar-toggle icon-btn" title="Redo" aria-label="Redo" onMouseDown={keepFocus} onClick={() => run("edit.redo")}><Icon name="redo" /></button>
    </span>
  );
}

function End() {
  return <Dropdown class="web-export" label="Export" icon="download" title="Export this document" items={EXPORT_ITEMS} />;
}

function Root() {
  // On a phone the Files drawer covers the page, so choosing a file closes it.
  createEffect(on(() => doc.filePath, () => { if (phone()) setSidebarOpen(false); }, { defer: true }));
  return (
    <>
      {/* The drawer covers its own toggle on a phone, so tapping off it closes it. */}
      <Show when={phone() && sidebarOpen()}>
        <button class="web-drawer-scrim" aria-label="Close sidebar" onClick={() => setSidebarOpen(false)} />
      </Show>
      <Show when={sheet()}><Sheet /></Show>
      <KeyBar />
    </>
  );
}

const SLOTS: Record<string, () => JSX.Element> = { start: Start, afterTabs: AfterTabs, actions: Actions, end: End, root: Root };

export const toolbar = (slot: string) => SLOTS[slot]();
