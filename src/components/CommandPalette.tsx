import { For, Show, createMemo, createSignal, createEffect } from "solid-js";
import { commandPaletteVisible, setCommandPaletteVisible, THEMES, theme } from "../store";
import { executeCommand } from "../commands";
import { MENUS, THEME_LABELS, type MenuNode, type MenuLeaf } from "../menudata";
import { DOTS } from "./PaletteSwitcher";
import { isMac } from "../platform";
import { ICONS } from "../menuicons";

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
