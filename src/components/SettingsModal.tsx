import ModalFrame from "./ModalFrame";
/**
 * Settings — a categorised dialog over the options that were previously
 * reachable only as menu items.
 *
 * Every row drives the *existing* command (`executeCommand("edit.spellcheck")`)
 * rather than setting state itself. One code path means the native menu's
 * checkmarks, the command palette and this dialog can never disagree, and a new
 * option needs no second implementation here.
 *
 * Rows are declared as data so the search field can filter across every
 * category at once — with ~25 options spread over six sections, hunting for
 * "the trailing newline one" by eye is the failure mode worth designing out.
 */

import { For, Show, createMemo, createSignal, type JSX } from "solid-js";
import {
  proseFont, setProseFont, monoFont, setMonoFont,
  spellcheckOn, smartPunctuation, preserveBreaks, lineEnding, finalNewline,
  autosaveInterval, copyImageToAssets, copyImagesToFolder, tableFullWidth,
  mathAltDelimiters, mathFence, emojiEnabled, highlightEnabled, subSupEnabled,
  autolinkEnabled, focusMode, typewriterMode, statusBarVisible, zoom, theme,
  setCopyImagesToFolder, customScheme, htmlEmbeds, setHtmlEmbedsSig, mathAutoNumber, setMathAutoNumberSig, physicsEnabled, setPhysicsEnabledSig, imageUploadUrl, setImageUploadUrl, bumpRenderEpoch,
} from "../store";
import { listSystemFonts, applyProseFont, applyMonoFont } from "../fonts";
import { setHtmlEmbeds, setMathAutoNumber, setPhysicsEnabled } from "../markdown";
import { setSetting } from "../settings";
import { executeCommand, toggleTableFullWidth } from "../commands";
import { openThemePicker } from "./ThemePicker";
import { openThemeEditor } from "./ThemeEditor";

const [visible, setVisible] = createSignal(false);
const [families, setFamilies] = createSignal<string[]>([]);
const [loading, setLoading] = createSignal(false);
let loaded = false;

/** Whether the Settings window is open (for the status-bar toggle's active state). */
export const isSettingsOpen = visible;

export function openSettings(section?: string) {
  setVisible(true);
  if (section) setSection(section);
  if (!loaded) {
    loaded = true;
    setLoading(true);
    // Hold the loader for a perceptible minimum even when the (cached) font scan
    // returns instantly, and only reveal the list once both resolve — otherwise a
    // populated list would replace the spinner before the eye registers it.
    const minVisible = new Promise<void>((r) => setTimeout(r, 500));
    void Promise.all([listSystemFonts(), minVisible]).then(([fonts]) => {
      setFamilies(fonts);
      setLoading(false);
    });
  }
}

const [section, setSection] = createSignal("appearance");

/* ---------- row model ---------- */

type Row =
  | { kind: "toggle"; id: string; label: string; desc?: string; get: () => boolean; run: () => void }
  | {
      kind: "select"; id: string; label: string; desc?: string;
      get: () => string; options: { value: string; label: string }[]; run: (v: string) => void;
    }
  | { kind: "text"; id: string; label: string; desc?: string; get: () => string; run: (v: string) => void }
  | { kind: "action"; id: string; label: string; desc?: string; button: string; run: () => void }
  | { kind: "node"; id: string; label: string; desc?: string; node: () => JSX.Element };

interface Section {
  id: string;
  label: string;
  rows: Row[];
}

const cmd = (id: string) => () => executeCommand(id);

const SECTIONS = (): Section[] => [
  {
    id: "appearance",
    label: "Appearance",
    rows: [
      {
        kind: "action", id: "theme", label: "Theme",
        desc: `Currently ${theme()}. Browse the gallery or build one from a base16 scheme.`,
        button: "Browse themes…", run: () => openThemePicker(),
      },
      {
        // Previously the only route to the editor was the gallery's Custom card
        // — four clicks from the status bar, and nothing in Settings mentioned
        // it existed. This is where people look for it.
        kind: "action", id: "custom_theme", label: "Custom theme",
        desc: customScheme()
          ? `Editing “${customScheme()!.name}” — sixteen base16 colours.`
          : "Build your own from a base16 scheme, or paste a published one.",
        button: customScheme() ? "Edit swatches…" : "Set up…",
        run: () => openThemeEditor(),
      },
      {
        kind: "node", id: "zoom", label: "Zoom", desc: "Scales the whole interface.",
        node: () => (
          <div class="set-stepper">
            <button onClick={cmd("view.zoom_out")} aria-label="Zoom out">−</button>
            <span>{zoom()}%</span>
            <button onClick={cmd("view.zoom_in")} aria-label="Zoom in">+</button>
            <button class="set-reset" onClick={cmd("view.zoom_actual")}>Reset</button>
          </div>
        ),
      },
      {
        kind: "toggle", id: "status_bar", label: "Status bar",
        desc: "Word count, caret position, encoding and theme along the bottom.",
        get: statusBarVisible, run: cmd("view.status_bar"),
      },
      {
        kind: "toggle", id: "tables_full", label: "Full-width tables",
        desc: "Stretch tables to the page column instead of sizing to content.",
        get: tableFullWidth, run: () => void toggleTableFullWidth(),
      },
    ],
  },
  {
    id: "editor",
    label: "Editor",
    rows: [
      {
        kind: "toggle", id: "spellcheck", label: "Check spelling while typing",
        get: spellcheckOn, run: cmd("edit.spellcheck"),
      },
      {
        kind: "toggle", id: "smart_punctuation", label: "Smart punctuation",
        desc: "Curly quotes, em dashes and ellipses as you type.",
        get: smartPunctuation, run: cmd("edit.smart_punctuation"),
      },
      {
        kind: "toggle", id: "focus_mode", label: "Focus mode",
        desc: "Dim everything except the paragraph you are editing.",
        get: focusMode, run: cmd("view.focus_mode"),
      },
      {
        kind: "toggle", id: "typewriter_mode", label: "Typewriter mode",
        desc: "Keep the line being edited vertically centred.",
        get: typewriterMode, run: cmd("view.typewriter_mode"),
      },
    ],
  },
  {
    id: "markdown",
    label: "Markdown",
    rows: [
      {
        kind: "toggle", id: "preserve_breaks", label: "Preserve single line breaks",
        desc: "Render a single newline as a line break instead of joining the lines.",
        get: preserveBreaks, run: cmd("edit.preserve_breaks"),
      },
      {
        kind: "toggle", id: "ext_highlight", label: "Highlight",
        desc: "==marked text== renders as a highlight.",
        get: highlightEnabled, run: cmd("edit.ext.highlight"),
      },
      {
        kind: "toggle", id: "ext_sub_sup", label: "Subscript and superscript",
        desc: "H~2~O and x^2^.",
        get: subSupEnabled, run: cmd("edit.ext.sub_sup"),
      },
      {
        kind: "toggle", id: "ext_emoji", label: "Emoji shortcodes",
        desc: ":smile: renders as an emoji.",
        get: emojiEnabled, run: cmd("edit.ext.emoji"),
      },
      {
        kind: "toggle", id: "ext_autolink", label: "Auto-link bare URLs",
        get: autolinkEnabled, run: cmd("edit.ext.autolink"),
      },
      {
        kind: "toggle", id: "math_alt", label: "LaTeX math delimiters",
        desc: "Also accept \\( \\) and \\[ \\] alongside $ and $$.",
        get: mathAltDelimiters, run: cmd("edit.math.alt_delimiters"),
      },
      {
        kind: "toggle", id: "math_physics", label: "Physics operator notation",
        desc: "Enable physics meanings for standard operators such as divergence and automatically sized trigonometric arguments.", get: physicsEnabled,
        run: () => { const value = !physicsEnabled(); setPhysicsEnabledSig(value); setPhysicsEnabled(value); bumpRenderEpoch(); void setSetting("physicsEnabled", value); },
      },
      {
        kind: "toggle", id: "math_numbering", label: "Number display equations",
        desc: "Add equation numbers; use \\label and \\ref for references.", get: mathAutoNumber,
        run: () => { const value = !mathAutoNumber(); setMathAutoNumberSig(value); setMathAutoNumber(value); bumpRenderEpoch(); void setSetting("mathAutoNumber", value); },
      },
      {
        kind: "toggle", id: "html_embeds", label: "Sandboxed web embeds",
        desc: "Load HTTPS iframe content with scripts isolated from the document.", get: htmlEmbeds,
        run: () => { const value = !htmlEmbeds(); setHtmlEmbedsSig(value); setHtmlEmbeds(value); bumpRenderEpoch(); void setSetting("htmlEmbeds", value); },
      },
      {
        kind: "toggle", id: "math_fence", label: "Math code fences",
        desc: "Render ```math fenced blocks as equations.",
        get: mathFence, run: cmd("edit.math.fence"),
      },
    ],
  },
  {
    id: "files",
    label: "Files",
    rows: [
      {
        kind: "select", id: "autosave", label: "Autosave",
        desc: "How often a saved document is written back to disk.",
        // The command id for "off" is `edit.autosave.off`, not `.0`, so the
        // select value has to match that vocabulary rather than the raw number.
        get: () => (autosaveInterval() === 0 ? "off" : String(autosaveInterval())),
        options: [
          { value: "off", label: "Off" },
          { value: "5", label: "Every 5 seconds" },
          { value: "15", label: "Every 15 seconds" },
          { value: "30", label: "Every 30 seconds" },
        ],
        run: (v) => executeCommand(`edit.autosave.${v}`),
      },
      {
        kind: "select", id: "line_ending", label: "Line endings",
        get: lineEnding,
        options: [
          { value: "lf", label: "LF (Unix)" },
          { value: "crlf", label: "CRLF (Windows)" },
        ],
        run: (v) => executeCommand(`edit.line_ending.${v}`),
      },
      {
        kind: "select", id: "final_newline", label: "Trailing newline",
        desc: "What to do with newlines at the end of the file on save.",
        get: finalNewline,
        options: [
          { value: "ensure", label: "Ensure one" },
          { value: "preserve", label: "Preserve as-is" },
          { value: "trim", label: "Trim all" },
        ],
        run: (v) => executeCommand(`edit.final_newline.${v}`),
      },
    ],
  },
  {
    id: "images",
    label: "Images",
    rows: [
      {
        kind: "toggle", id: "copy_images", label: "Copy inserted images into the document folder",
        desc: "Keeps a document portable by copying local images next to it.",
        get: copyImageToAssets, run: cmd("format.image.copy_to_folder"),
      },
      {
        kind: "text", id: "image_upload_url", label: "Image upload URL",
        desc: 'HTTPS service accepting multipart field "file" and returning {"url":"https://…"}. Upload from the image menu. The service must allow this app’s origin.',
        get: imageUploadUrl, run: value => { setImageUploadUrl(value.trim()); void setSetting("imageUploadUrl", value.trim()); },
      },
      {
        kind: "text", id: "assets_folder", label: "Assets folder",
        desc: "Where copies are placed, relative to the document. ${filename} expands to its base name.",
        get: copyImagesToFolder,
        run: (v) => {
          setCopyImagesToFolder(v);
          void setSetting("copyImagesToFolder", v);
        },
      },
      {
        kind: "action", id: "image_root", label: "Image root path",
        desc: "Folder that root-relative image links (/img/x.png) resolve against.",
        button: "Choose folder…", run: cmd("format.image.root_path"),
      },
    ],
  },
  { id: "fonts", label: "Fonts", rows: [] },
];

/* ---------- rendering ---------- */

function Toggle(props: { on: boolean; onClick: () => void; label: string }) {
  return (
    <button
      class="set-switch"
      classList={{ on: props.on }}
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      onClick={() => props.onClick()}
    >
      <span class="set-knob" />
    </button>
  );
}

function RowView(props: { row: Row }) {
  const r = () => props.row;
  return (
    <div class="set-row">
      <div class="set-row-text">
        <span class="set-row-label">{r().label}</span>
        <Show when={r().desc}>
          <span class="set-row-desc">{r().desc}</span>
        </Show>
      </div>
      <div class="set-row-ctl">
        <Show when={r().kind === "toggle"}>
          {(() => {
            const row = r() as Extract<Row, { kind: "toggle" }>;
            return <Toggle on={row.get()} onClick={row.run} label={row.label} />;
          })()}
        </Show>
        <Show when={r().kind === "select"}>
          {(() => {
            const row = r() as Extract<Row, { kind: "select" }>;
            return (
              <select aria-label={row.label} class="ip-input ip-select" value={row.get()} onChange={(e) => row.run(e.currentTarget.value)}>
                <For each={row.options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
              </select>
            );
          })()}
        </Show>
        <Show when={r().kind === "text"}>
          {(() => {
            const row = r() as Extract<Row, { kind: "text" }>;
            return (
              <input
                class="ip-input"
                aria-label={row.label}
                value={row.get()}
                spellcheck={false}
                onChange={(e) => row.run(e.currentTarget.value)}
              />
            );
          })()}
        </Show>
        <Show when={r().kind === "action"}>
          {(() => {
            const row = r() as Extract<Row, { kind: "action" }>;
            return <button class="ghost-btn" onClick={row.run}>{row.button}</button>;
          })()}
        </Show>
        <Show when={r().kind === "node"}>
          {(r() as Extract<Row, { kind: "node" }>).node()}
        </Show>
      </div>
    </div>
  );
}

export default function SettingsModal() {
  const [target, setTarget] = createSignal<"prose" | "mono">("prose");
  const [fontQuery, setFontQuery] = createSignal("");
  const [query, setQuery] = createSignal("");

  const current = () => (target() === "prose" ? proseFont() : monoFont());

  const fonts = createMemo(() => {
    const q = fontQuery().trim().toLowerCase();
    const list = families();
    return (q ? list.filter((f) => f.toLowerCase().includes(q)) : list).slice(0, 300);
  });

  const choose = async (family: string | null) => {
    if (target() === "prose") {
      setProseFont(family);
      applyProseFont(family);
      await setSetting("proseFont", family);
    } else {
      setMonoFont(family);
      applyMonoFont(family);
      await setSetting("monoFont", family);
    }
  };

  /** Sections to render: all of them while searching, else the selected one. */
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    if (!q) return SECTIONS().filter((s) => s.id === section());
    return SECTIONS()
      .map((s) => ({
        ...s,
        rows: s.rows.filter(
          (r) => r.label.toLowerCase().includes(q) || (r.desc ?? "").toLowerCase().includes(q),
        ),
      }))
      .filter((s) => s.rows.length);
  });

  const searching = () => query().trim().length > 0;
  const showFonts = () => !searching() && section() === "fonts";

  return (
    <Show when={visible()}>
      <div
        class="settings-backdrop"
        onMouseDown={(e) => e.target === e.currentTarget && setVisible(false)}
      >
        <ModalFrame class="settings" label="Settings" onClose={() => setVisible(false)}>
          <nav class="set-rail" aria-label="Settings sections">
            <span class="set-rail-title">Settings</span>
            <For each={SECTIONS()}>
              {(s) => (
                <button
                  class="set-rail-item" aria-current={!searching() && section() === s.id ? "page" : undefined}
                  classList={{ on: !searching() && section() === s.id }}
                  onClick={() => { setQuery(""); setSection(s.id); }}
                >
                  {s.label}
                </button>
              )}
            </For>
          </nav>

          <div class="set-pane">
            <div class="set-pane-head">
              <input
                class="settings-search"
                aria-label="Search settings" placeholder="Search settings…"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                autocomplete="off"
                spellcheck={false}
              />
              <button class="ip-close" title="Close" onClick={() => setVisible(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>

            <div class="set-body">
              <Show when={showFonts()}>
                <div class="settings-tabs">
                  <button aria-pressed={target() === "prose"} classList={{ on: target() === "prose" }} onClick={() => setTarget("prose")}>
                    Editor font
                  </button>
                  <button aria-pressed={target() === "mono"} classList={{ on: target() === "mono" }} onClick={() => setTarget("mono")}>
                    Code font
                  </button>
                </div>
                <div class="settings-current">
                  <span>Current: <strong>{current() ?? "System default"}</strong></span>
                  <button class="ghost-btn" disabled={!current()} onClick={() => void choose(null)}>
                    Reset to default
                  </button>
                </div>
                <input
                  class="settings-search set-font-search"
                  aria-label="Search fonts" placeholder="Search fonts…"
                  value={fontQuery()}
                  onInput={(e) => setFontQuery(e.currentTarget.value)}
                  autocomplete="off"
                  spellcheck={false}
                />
                <div class="settings-list">
                  <Show
                    when={fonts().length}
                    fallback={
                      <Show
                        when={loading()}
                        fallback={
                          <div class="settings-empty">
                            {families().length ? "No matching fonts" : "No system fonts available"}
                          </div>
                        }
                      >
                        <div class="settings-loading">
                          <span class="settings-spinner" aria-hidden="true" />
                          Loading fonts…
                        </div>
                      </Show>
                    }
                  >
                    <For each={fonts()}>
                      {(f) => (
                        <button
                          class="settings-font"
                          aria-pressed={current() === f} classList={{ current: current() === f }}
                          style={{ "font-family": `"${f}"` }}
                          onClick={() => void choose(f)}
                        >
                          {f}
                        </button>
                      )}
                    </For>
                  </Show>
                </div>
              </Show>

              <Show when={!showFonts()}>
                <Show
                  when={shown().length}
                  fallback={<div class="settings-empty">No settings match “{query()}”.</div>}
                >
                  <For each={shown()}>
                    {(s) => (
                      <>
                        {/* While searching, results stay grouped so a match's
                            context (which category it belongs to) is not lost. */}
                        <Show when={searching()}>
                          <div class="side-list-head set-group">{s.label}</div>
                        </Show>
                        <For each={s.rows}>{(row) => <RowView row={row} />}</For>
                      </>
                    )}
                  </For>
                </Show>
              </Show>
            </div>
          </div>
        </ModalFrame>
      </div>
    </Show>
  );
}
