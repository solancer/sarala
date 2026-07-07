import { For, Show, createMemo, createSignal, createEffect } from "solid-js";
import { commandPaletteVisible, setCommandPaletteVisible, THEMES, theme } from "../store";
import { executeCommand } from "../commands";
import { MENUS, THEME_LABELS, type MenuNode, type MenuLeaf } from "../menudata";
import { DOTS } from "./PaletteSwitcher";
import { isMac } from "../platform";

// Icon path data (24×24, stroked), lifted from the design spec.
const ICONS: Record<string, string> = {
  file: '<path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  save: '<path d="M5 3h11l3 3v15H5zM8 3v6h8"/>',
  download: '<path d="M12 3v12m-4-4 4 4 4-4M5 21h14"/>',
  bold: '<path d="M7 5h7a3.5 3.5 0 0 1 0 7H7zM7 12h8a3.5 3.5 0 0 1 0 7H7z"/>',
  italic: '<path d="M19 5h-6M11 19H5M15 5 9 19"/>',
  underline: '<path d="M6 4v6a6 6 0 0 0 12 0V4M4 20h16"/>',
  strike: '<path d="M5 12h14M8 7a4 3 0 0 1 8 0M8 17a4 3 0 0 0 8 0"/>',
  code: '<path d="m9 8-4 4 4 4M15 8l4 4-4 4"/>',
  link: '<path d="M9 15l6-6M10 6l1-1a4 4 0 0 1 6 6l-1 1M14 18l-1 1a4 4 0 0 1-6-6l1-1"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
  math: '<path d="M18 7V4H6l6 8-6 8h12v-3"/>',
  clear: '<path d="m7 21-4.3-4.3a2 2 0 0 1 0-2.8l9.6-9.6a2 2 0 0 1 2.8 0l4.8 4.8a2 2 0 0 1 0 2.8L13 21M22 21H7m-2-10 9 9"/>',
  check: '<path d="m3 7 2 2 4-4M3 17l2 2 4-4M13 6h8M13 12h8M13 18h8"/>',
  h1: '<path d="M4 6v12M12 6v12M4 12h8"/><path d="M17 10l3-2v10"/>',
  h2: '<path d="M4 6v12M12 6v12M4 12h8"/><path d="M17 9a2 2 0 1 1 3 1.6L17 18h4"/>',
  h3: '<path d="M4 6v12M12 6v12M4 12h8"/><path d="M17 8h3l-2 3a2 2 0 1 1-1 3.5"/>',
  quote: '<path d="M6 17h3l2-4V7H5v6h3zM14 17h3l2-4V7h-6v6h3z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  table: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 10h18M9 5v14"/>',
  hr: '<path d="M4 12h16"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  statusbar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 16h18"/>',
  focus: '<circle cx="12" cy="12" r="3"/><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>',
  type: '<path d="M5 6h14M12 6v13M9 19h6"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
};

interface Cmd {
  group: string;
  id: string;
  label: string;
  /** Icon key from ICONS; omitted for theme rows (which show a colour swatch). */
  icon?: string;
  /** Theme id — renders a colour swatch instead of an icon. */
  theme?: string;
}

// Curated palette contents, mirroring the design spec (nicer labels + icons)
// but pointing at the app's real command ids so they actually execute.
const BASE: Cmd[] = [
  { group: "File", id: "file.new", label: "New File", icon: "file" },
  { group: "File", id: "file.open_folder", label: "Open Folder", icon: "folder" },
  { group: "File", id: "file.save", label: "Save", icon: "save" },
  { group: "File", id: "file.export.pdf", label: "Export as PDF", icon: "download" },
  { group: "File", id: "file.export.html", label: "Export as HTML", icon: "download" },
  { group: "Format", id: "format.strong", label: "Bold", icon: "bold" },
  { group: "Format", id: "format.emphasis", label: "Italic", icon: "italic" },
  { group: "Format", id: "format.underline", label: "Underline", icon: "underline" },
  { group: "Format", id: "format.strike", label: "Strikethrough", icon: "strike" },
  { group: "Format", id: "format.code", label: "Inline Code", icon: "code" },
  { group: "Format", id: "format.inline_math", label: "Inline Math", icon: "math" },
  { group: "Format", id: "format.hyperlink", label: "Insert Link", icon: "link" },
  { group: "Format", id: "format.image.insert", label: "Insert Image", icon: "image" },
  { group: "Format", id: "format.clear", label: "Clear Format", icon: "clear" },
  { group: "Paragraph", id: "paragraph.heading.1", label: "Heading 1", icon: "h1" },
  { group: "Paragraph", id: "paragraph.heading.2", label: "Heading 2", icon: "h2" },
  { group: "Paragraph", id: "paragraph.heading.3", label: "Heading 3", icon: "h3" },
  { group: "Paragraph", id: "paragraph.heading.4", label: "Heading 4", icon: "type" },
  { group: "Paragraph", id: "paragraph.heading.5", label: "Heading 5", icon: "type" },
  { group: "Paragraph", id: "paragraph.heading.6", label: "Heading 6", icon: "type" },
  { group: "Paragraph", id: "paragraph.heading.0", label: "Paragraph (Normal Text)", icon: "type" },
  { group: "Paragraph", id: "paragraph.quote", label: "Blockquote", icon: "quote" },
  { group: "Paragraph", id: "paragraph.unordered_list", label: "Bullet List", icon: "list" },
  { group: "Paragraph", id: "paragraph.ordered_list", label: "Numbered List", icon: "list" },
  { group: "Paragraph", id: "paragraph.task_list", label: "Task List", icon: "check" },
  { group: "Paragraph", id: "paragraph.code_fences", label: "Code Block", icon: "code" },
  { group: "Paragraph", id: "paragraph.math_block", label: "Math Block", icon: "math" },
  { group: "Paragraph", id: "paragraph.table.insert", label: "Insert Table", icon: "table" },
  { group: "Paragraph", id: "paragraph.hr", label: "Horizontal Rule", icon: "hr" },
  { group: "Paragraph", id: "paragraph.toc", label: "Table of Contents", icon: "list" },
  { group: "Paragraph", id: "paragraph.footnote", label: "Link Reference / Footnote", icon: "link" },
  { group: "View", id: "view.sidebar", label: "Toggle Sidebar", icon: "sidebar" },
  { group: "View", id: "view.focus_mode", label: "Toggle Focus Mode", icon: "focus" },
  { group: "View", id: "view.typewriter_mode", label: "Toggle Typewriter Mode", icon: "type" },
  { group: "View", id: "view.source_mode", label: "Toggle Source Mode", icon: "eye" },
  { group: "View", id: "view.status_bar", label: "Toggle Status Bar", icon: "statusbar" },
  { group: "View", id: "app.settings", label: "Typography Settings", icon: "type" },
];
const COMMANDS: Cmd[] = [
  ...BASE,
  ...THEMES.map((id) => ({
    group: "Themes",
    id: `themes.set.${id}`,
    label: `Theme: ${THEME_LABELS[id] ?? id}`,
    theme: id,
  })),
];

// id → accelerator (raw menudata form) so key hints stay in sync with the menu.
const ACCELS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  const walk = (nodes: MenuNode[]) => {
    for (const n of nodes) {
      if ("sep" in n || "dynamic" in n) continue;
      const leaf = n as MenuLeaf;
      if (leaf.id && leaf.accel) out[leaf.id] = leaf.accel;
      if (leaf.items) walk(leaf.items);
    }
  };
  for (const m of MENUS) walk(m.items);
  return out;
})();

/** Format a menudata accelerator for display (⌘⇧K on mac, Ctrl+Shift+K elsewhere). */
function formatAccel(id: string): string {
  const raw = ACCELS[id];
  if (!raw) return "";
  const mod: Record<string, string> = isMac
    ? { Ctrl: "⌘", Shift: "⇧", Alt: "⌥", CmdOrCtrl: "⌘" }
    : { Ctrl: "Ctrl", Shift: "Shift", Alt: "Alt", CmdOrCtrl: "Ctrl" };
  const key: Record<string, string> = {
    Comma: ",", Slash: "/", Minus: "−", Plus: "+", Equal: "=", Backslash: "\\",
  };
  const parts = raw.split("+").map((p) => mod[p] ?? key[p] ?? p);
  return isMac ? parts.join("") : parts.join("+");
}

/** Row icon. ICONS is static, hand-authored markup, so it's set imperatively
 *  via a ref (the app's pattern) rather than the flagged JSX innerHTML prop. */
function Icon(props: { name?: string }) {
  return (
    <svg
      class="cr-ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      ref={(el) => (el.innerHTML = ICONS[props.name ?? ""] ?? "")}
    />
  );
}

export default function CommandPalette() {
  const [query, setQuery] = createSignal("");
  const [cursor, setCursor] = createSignal(0);
  let inputEl: HTMLInputElement | undefined;
  let listEl: HTMLDivElement | undefined;

  const matches = createMemo(() => {
    if (!commandPaletteVisible()) return [];
    const q = query().toLowerCase().trim();
    if (!q) return COMMANDS;
    return COMMANDS.filter(
      (c) => c.label.toLowerCase().includes(q) || c.group.toLowerCase().includes(q),
    );
  });

  createEffect(() => {
    if (commandPaletteVisible()) {
      setQuery("");
      setCursor(0);
      queueMicrotask(() => inputEl?.focus());
    }
  });

  const close = () => setCommandPaletteVisible(false);
  const run = (c: Cmd | undefined) => {
    if (!c) return;
    close();
    executeCommand(c.id);
  };

  const scrollToCursor = () => {
    queueMicrotask(() => {
      listEl?.querySelector<HTMLElement>(".cmd-row.sel")
        ?.scrollIntoView({ block: "nearest" });
    });
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); close(); }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(c + 1, matches().length - 1));
      scrollToCursor();
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(c - 1, 0));
      scrollToCursor();
    }
    if (e.key === "Enter") { e.preventDefault(); run(matches()[cursor()]); }
  };

  return (
    <Show when={commandPaletteVisible()}>
      <div class="cmd-overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <div class="cmd" role="dialog" aria-label="Command palette">
          <div class="cmd-in">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
            </svg>
            <input
              ref={inputEl}
              placeholder="Type a command or search…"
              value={query()}
              onInput={(e) => { setQuery(e.currentTarget.value); setCursor(0); }}
              onKeyDown={onKeyDown}
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck={false}
            />
            <span class="cmd-esc">ESC</span>
          </div>
          <Show
            when={matches().length}
            fallback={<div class="cmd-empty">No commands match “{query()}”</div>}
          >
            <div class="cmd-list" ref={listEl}>
              <For each={matches()}>
                {(c, i) => (
                  <>
                    <Show when={i() === 0 || matches()[i() - 1].group !== c.group}>
                      <div class="cmd-group">{c.group}</div>
                    </Show>
                    <div
                      class="cmd-row"
                      classList={{ sel: i() === cursor() }}
                      onMouseDown={() => run(c)}
                      onMouseMove={() => setCursor(i())}
                    >
                      <Show when={c.theme} fallback={<Icon name={c.icon} />}>
                        <span
                          class="cr-sw"
                          classList={{ on: theme() === c.theme }}
                          style={{ background: DOTS[c.theme!] ?? "var(--accent)" }}
                        />
                      </Show>
                      <span class="cr-label">{c.label}</span>
                      <Show when={formatAccel(c.id)}>
                        <span class="cr-key">{formatAccel(c.id)}</span>
                      </Show>
                    </div>
                  </>
                )}
              </For>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}
