import { THEME_LABELS } from "../menudata";
import { ICONS } from "../menuicons";
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

import { For, Show, createEffect, createMemo, createSignal, untrack, type JSX } from "solid-js";
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
import { AiAgentStatus } from "./AiSettings";
import {
  AGENTS, aiAgent, aiAgentPath, aiEnabled, aiModel, aiRailVisible, setAiAgent, setAiAgentPath, setAiEnabled,
  setAiModel, setAiRailVisible,
} from "../ai/config";
import type { AgentId } from "../ai/types";
import { VoiceDeviceRow, VoiceInstalledRow, VoiceModelRow, VoiceShortcutRow, VoiceTriggerRow } from "./VoiceSettings";
import {
  COMMAND_KEYS, IDLE_OPTIONS, LANGUAGES, setVoiceCommandKey, voiceCommandKey, PAUSE_OPTIONS, PAUSE_SECONDS, setVoiceCommands,
  setVoiceEnabled, setVoiceIdleMinutes, setVoiceLanguage, setVoicePause, setVoicePauseSeconds, setVoicePunctuation, setVoiceReadBack,
  setVoiceShowButton, setVoiceSounds, voiceCommands, voiceEnabled, voiceIdleMinutes, voiceLanguage, voiceModel, voicePause,
  voiceShowButton, voicePauseSeconds, voicePunctuation, voiceReadBack, voiceSounds, type PauseMode,
} from "../voice/config";
import { cancelDictation, openVoiceSetup } from "../voice/session";
import { voiceBackend } from "../voice/transport";

const [visible, setVisible] = createSignal(false);
const [families, setFamilies] = createSignal<string[]>([]);
const [loading, setLoading] = createSignal(false);
let loaded = false;

/** Whether the Settings window is open (for the status-bar toggle's active state). */
export const isSettingsOpen = visible;
/** Close it, e.g. to hand over to a set-up dialog instead of stacking on top. */
export const closeSettings = () => setVisible(false);

export function openSettings(section?: string) {
  setVisible(true);
  if (section) setSection(section);
  // The dialog focuses its first control (the Appearance tab); when it opens
  // on another section, move focus to that section's tab instead, so focus
  // and the selected section agree.
  requestAnimationFrame(() =>
    document.querySelector<HTMLElement>('.settings .set-rail-item[aria-current="page"]')?.focus({ preventScroll: true }),
  );
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

/**
 * `group` starts a titled group of rows. `advanced` rows are folded into one
 * collapsible "Advanced" group at the end of their section (less-used options
 * out of the way, still found by search). `when` hides a row that doesn't
 * apply right now, e.g. voice options while voice typing is off.
 */
type Row = { group?: string; advanced?: boolean; when?: () => boolean } & (
  | { kind: "toggle"; id: string; label: string; desc?: string; get: () => boolean; run: () => void }
  | {
      kind: "select"; id: string; label: string; desc?: string;
      get: () => string; options: { value: string; label: string }[]; run: (v: string) => void;
    }
  | { kind: "text"; id: string; label: string; desc?: string; get: () => string; run: (v: string) => void }
  | { kind: "action"; id: string; label: string; desc?: string; button: string; run: () => void }
  | { kind: "node"; id: string; label: string; desc?: string; node: () => JSX.Element }
);

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
        group: "Theme", kind: "action", id: "theme", label: "Theme",
        desc: `Currently ${THEME_LABELS[theme()] ?? (customScheme() ? "Custom" : theme())}.`,
        button: "Browse themes…", run: () => openThemePicker(),
      },
      {
        // Previously the only route to the editor was the gallery's Custom card
        // — four clicks from the status bar, and nothing in Settings mentioned
        // it existed. This is where people look for it.
        kind: "action", id: "custom_theme", label: "Custom theme",
        desc: customScheme() ? `Editing “${customScheme()!.name}”.` : "Build one from a base16 scheme.",
        button: customScheme() ? "Edit swatches…" : "Set up…",
        run: () => openThemeEditor(),
      },
      {
        group: "Layout", kind: "node", id: "zoom", label: "Zoom", desc: "Scales the whole interface.",
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
        desc: "Word count, position and encoding.",
        get: statusBarVisible, run: cmd("view.status_bar"),
      },
      {
        kind: "toggle", id: "tables_full", label: "Full-width tables",
        desc: "Stretch tables to the page width.",
        get: tableFullWidth, run: () => void toggleTableFullWidth(),
      },
    ],
  },
  {
    id: "editor",
    label: "Editor",
    rows: [
      {
        group: "Typing", kind: "toggle", id: "spellcheck", label: "Check spelling",
        desc: "Underline misspelled words as you type.",
        get: spellcheckOn, run: cmd("edit.spellcheck"),
      },
      {
        kind: "toggle", id: "smart_punctuation", label: "Smart punctuation",
        desc: "Curly quotes, em dashes and ellipses.",
        get: smartPunctuation, run: cmd("edit.smart_punctuation"),
      },
      {
        group: "Writing modes", kind: "toggle", id: "focus_mode", label: "Focus mode",
        desc: "Dim everything but the current paragraph.",
        get: focusMode, run: cmd("view.focus_mode"),
      },
      {
        kind: "toggle", id: "typewriter_mode", label: "Typewriter mode",
        desc: "Keep the current line centred.",
        get: typewriterMode, run: cmd("view.typewriter_mode"),
      },
    ],
  },
  {
    id: "markdown",
    label: "Markdown",
    rows: [
      {
        group: "Syntax", kind: "toggle", id: "preserve_breaks", label: "Keep single line breaks",
        desc: "A single newline becomes a line break.",
        get: preserveBreaks, run: cmd("edit.preserve_breaks"),
      },
      {
        kind: "toggle", id: "ext_autolink", label: "Link bare URLs",
        desc: "https://… becomes a link.",
        get: autolinkEnabled, run: cmd("edit.ext.autolink"),
      },
      {
        kind: "toggle", id: "ext_highlight", label: "Highlight",
        desc: "==marked text==",
        get: highlightEnabled, run: cmd("edit.ext.highlight"),
      },
      {
        kind: "toggle", id: "ext_sub_sup", label: "Subscript and superscript",
        desc: "H~2~O and x^2^",
        get: subSupEnabled, run: cmd("edit.ext.sub_sup"),
      },
      {
        kind: "toggle", id: "ext_emoji", label: "Emoji shortcodes",
        desc: ":smile: becomes an emoji.",
        get: emojiEnabled, run: cmd("edit.ext.emoji"),
      },
      {
        group: "Math", kind: "toggle", id: "math_alt", label: "LaTeX delimiters",
        desc: "Also \\( \\) and \\[ \\], besides $ and $$.",
        get: mathAltDelimiters, run: cmd("edit.math.alt_delimiters"),
      },
      {
        kind: "toggle", id: "math_fence", label: "Math code fences",
        desc: "```math blocks render as equations.",
        get: mathFence, run: cmd("edit.math.fence"),
      },
      {
        kind: "toggle", id: "math_numbering", label: "Number equations",
        desc: "Refer to them with \\label and \\ref.", get: mathAutoNumber,
        run: () => { const value = !mathAutoNumber(); setMathAutoNumberSig(value); setMathAutoNumber(value); bumpRenderEpoch(); void setSetting("mathAutoNumber", value); },
      },
      {
        advanced: true, kind: "toggle", id: "math_physics", label: "Physics notation",
        desc: "Physics meanings for operators like div and grad.", get: physicsEnabled,
        run: () => { const value = !physicsEnabled(); setPhysicsEnabledSig(value); setPhysicsEnabled(value); bumpRenderEpoch(); void setSetting("physicsEnabled", value); },
      },
      {
        advanced: true, kind: "toggle", id: "html_embeds", label: "Web embeds",
        desc: "Load HTTPS iframes, with scripts sandboxed.", get: htmlEmbeds,
        run: () => { const value = !htmlEmbeds(); setHtmlEmbedsSig(value); setHtmlEmbeds(value); bumpRenderEpoch(); void setSetting("htmlEmbeds", value); },
      },
    ],
  },
  {
    id: "files",
    label: "Files",
    rows: [
      {
        kind: "select", id: "autosave", label: "Autosave",
        desc: "Write saved documents back to disk.",
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
        advanced: true, kind: "select", id: "line_ending", label: "Line endings",
        desc: "Used when saving.",
        get: lineEnding,
        options: [
          { value: "lf", label: "LF (Unix)" },
          { value: "crlf", label: "CRLF (Windows)" },
        ],
        run: (v) => executeCommand(`edit.line_ending.${v}`),
      },
      {
        advanced: true, kind: "select", id: "final_newline", label: "Trailing newline",
        desc: "At the end of the file, on save.",
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
        kind: "toggle", id: "copy_images", label: "Copy images next to the document",
        desc: "Keeps the document portable.",
        get: copyImageToAssets, run: cmd("format.image.copy_to_folder"),
      },
      {
        kind: "text", id: "assets_folder", label: "Assets folder", when: copyImageToAssets,
        desc: "Relative to the document. ${filename} is its name.",
        get: copyImagesToFolder,
        run: (v) => {
          setCopyImagesToFolder(v);
          void setSetting("copyImagesToFolder", v);
        },
      },
      {
        advanced: true, kind: "action", id: "image_root", label: "Image root path",
        desc: "Where links like /img/x.png resolve.",
        button: "Choose folder…", run: cmd("format.image.root_path"),
      },
      {
        advanced: true, kind: "text", id: "image_upload_url", label: "Image upload URL",
        desc: 'HTTPS endpoint: takes form field "file", returns {"url": …}.',
        get: imageUploadUrl, run: value => { setImageUploadUrl(value.trim()); void setSetting("imageUploadUrl", value.trim()); },
      },
    ],
  },
  { id: "fonts", label: "Fonts", rows: [] },
  {
    id: "ai",
    label: "AI",
    rows: [
      {
        kind: "toggle", id: "ai_enabled", label: "AI assistant",
        desc: "Uses an AI agent on this computer. You approve every edit.",
        get: aiEnabled, run: () => void setAiEnabled(!aiEnabled()),
      },
      {
        kind: "select", id: "ai_agent", label: "Agent", when: aiEnabled,
        desc: "Works on a private copy of the document.",
        get: aiAgent, options: AGENTS.map((a) => ({ value: a.id, label: a.label })),
        run: (v) => void setAiAgent(v as AgentId),
      },
      { kind: "node", id: "ai_status", label: "Status", when: aiEnabled, node: () => <AiAgentStatus /> },
      {
        kind: "toggle", id: "ai_rail", label: "Assistant bar",
        desc: "The assistant button on the right edge.",
        get: aiRailVisible, run: () => void setAiRailVisible(!aiRailVisible()),
      },
      {
        advanced: true, when: aiEnabled, kind: "text", id: "ai_model", label: "Model",
        desc: "Empty uses the agent's default (its --model option).",
        get: aiModel, run: (v) => void setAiModel(v),
      },
      {
        advanced: true, when: aiEnabled, kind: "text", id: "ai_path", label: "Program path",
        desc: "Empty finds it automatically.",
        get: aiAgentPath, run: (v) => void setAiAgentPath(v),
      },
    ],
  },
  {
    id: "voice",
    label: "Voice",
    rows: [
      {
        group: "General", kind: "toggle", id: "voice_enabled", label: "Voice typing",
        desc: "Speech to text on this computer. Nothing is uploaded.",
        get: voiceEnabled,
        run: () => {
          if (voiceEnabled()) {
            void cancelDictation();
            void setVoiceEnabled(false);
            void voiceBackend().then((b) => b.unload());
          } else if (!voiceModel()) {
            // Turning it on starts the set-up: a model has to be chosen and downloaded.
            openVoiceSetup();
          } else {
            void setVoiceEnabled(true);
          }
        },
      },
      {
        kind: "node", id: "voice_shortcut", label: "Shortcut", when: voiceEnabled,
        desc: "Works while Sarala is in front.",
        node: () => <VoiceShortcutRow />,
      },
      {
        kind: "node", id: "voice_trigger", label: "Shortcut behaviour", when: voiceEnabled,
        desc: "Hold to talk, tap to start and stop, or either.",
        node: () => <VoiceTriggerRow compact />,
      },
      {
        kind: "toggle", id: "voice_show_button", label: "Mic button",
        desc: "Beside Focus mode, top right.",
        get: voiceShowButton, run: () => void setVoiceShowButton(!voiceShowButton()),
      },
      { group: "Microphone & sound", when: voiceEnabled, kind: "node", id: "voice_device", label: "Microphone", node: () => <VoiceDeviceRow /> },
      {
        kind: "toggle", id: "voice_sounds", label: "Sounds", when: voiceEnabled,
        desc: "A short tone when listening starts and stops.",
        get: voiceSounds, run: () => void setVoiceSounds(!voiceSounds()),
      },
      { group: "Speech", when: voiceEnabled, kind: "node", id: "voice_model", label: "Speech model", desc: "Downloaded once, then works offline.", node: () => <VoiceModelRow /> },
      {
        kind: "select", id: "voice_language", label: "Language", when: voiceEnabled,
        desc: "Used by multilingual models.",
        get: voiceLanguage, options: LANGUAGES, run: (v) => void setVoiceLanguage(v),
      },
      {
        kind: "select", id: "voice_pause", label: "When you pause", when: voiceEnabled,
        desc: "“Type, keep going” is hands-free dictation.",
        get: voicePause, options: PAUSE_OPTIONS, run: (v) => void setVoicePause(v as PauseMode),
      },
      {
        kind: "select", id: "voice_pause_length", label: "Pause length",
        // Only matters when a pause does something.
        when: () => voiceEnabled() && voicePause() !== "keep",
        get: () => String(voicePauseSeconds()), options: PAUSE_SECONDS, run: (v) => void setVoicePauseSeconds(Number(v)),
      },
      {
        kind: "toggle", id: "voice_commands", label: "Voice commands", when: voiceEnabled,
        desc: "“New paragraph”, “scratch that”, “what can I say”…",
        get: voiceCommands, run: () => void setVoiceCommands(!voiceCommands()),
      },
      {
        advanced: true, when: voiceEnabled, kind: "select", id: "voice_command_key", label: "Command key",
        desc: "Tap alone to start or stop; hold to say a command.",
        get: voiceCommandKey, options: COMMAND_KEYS.map((k) => ({ value: k.id, label: k.label })),
        run: (v) => void setVoiceCommandKey(v),
      },
      {
        advanced: true, when: voiceEnabled, kind: "toggle", id: "voice_punctuation", label: "Spoken punctuation",
        desc: "Say “comma”, “period”… The models punctuate on their own.",
        get: voicePunctuation, run: () => void setVoicePunctuation(!voicePunctuation()),
      },
      {
        advanced: true, when: voiceEnabled, kind: "toggle", id: "voice_read_back", label: "Read back what was typed",
        desc: "Screen readers announce the typed words.",
        get: voiceReadBack, run: () => void setVoiceReadBack(!voiceReadBack()),
      },
      {
        advanced: true, when: voiceEnabled, kind: "select", id: "voice_idle", label: "Free the model's memory",
        desc: "Keeping it loaded makes starting instant.",
        get: () => String(voiceIdleMinutes()), options: IDLE_OPTIONS,
        run: (v) => void setVoiceIdleMinutes(Number(v)),
      },
      { advanced: true, when: voiceEnabled, kind: "node", id: "voice_installed", label: "Downloaded models", node: () => <VoiceInstalledRow /> },
    ],
  },
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

/** One icon per page, from the app's shared 24×24 stroked set (the menus and
 *  command palette use the same glyphs). */
const SECTION_ICONS: Record<string, string> = {
  appearance: "palette", editor: "pencil", markdown: "markdown", files: "folder",
  images: "image", fonts: "type", ai: "sparkle", voice: "mic",
};
function SectionIcon(props: { id: string; class: string }) {
  let el!: SVGSVGElement;
  // An effect, not a one-off ref: the page header's icon follows the page.
  createEffect(() => (el.innerHTML = ICONS[SECTION_ICONS[props.id]] ?? ""));
  return (
    <svg
      ref={el} class={props.class} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"
    />
  );
}

/** The current row with this id; keeps the last one while it is being removed. */
function RowById(props: { id: string; rows: () => Row[] }) {
  let last: Row | undefined;
  const row = () => (last = props.rows().find((r) => r.id === props.id) ?? last)!;
  return <RowView row={row()} />;
}

function RowView(props: { row: Row }) {
  const r = () => props.row;
  // Each control is built once (untracked) and reads the current row through
  // getters. Rows are rebuilt as new objects whenever settings change, and
  // rebuilding the control would drop keyboard focus (and reset a node row's
  // own state, like a shortcut being recorded).
  const as = <K extends Row["kind"]>() => r() as Extract<Row, { kind: K }>;
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
          {untrack(() => <Toggle on={as<"toggle">().get()} onClick={() => as<"toggle">().run()} label={as<"toggle">().label} />)}
        </Show>
        <Show when={r().kind === "select"}>
          {untrack(() => (
            <select aria-label={as<"select">().label} class="ip-input ip-select" value={as<"select">().get()} onChange={(e) => as<"select">().run(e.currentTarget.value)}>
              <For each={as<"select">().options}>{(o) => <option value={o.value}>{o.label}</option>}</For>
            </select>
          ))}
        </Show>
        <Show when={r().kind === "text"}>
          {untrack(() => (
            <input
              class="ip-input"
              aria-label={as<"text">().label}
              value={as<"text">().get()}
              spellcheck={false}
              onChange={(e) => as<"text">().run(e.currentTarget.value)}
            />
          ))}
        </Show>
        <Show when={r().kind === "action"}>
          {untrack(() => <button class="ghost-btn" onClick={() => as<"action">().run()}>{as<"action">().button}</button>)}
        </Show>
        <Show when={r().kind === "node"}>
          {untrack(() => as<"node">().node())}
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

  const searching = () => query().trim().length > 0;
  /** Sections to render: all of them while searching, else the selected one. */
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase();
    const applies = (r: Row) => r.when?.() ?? true;
    if (!q) return SECTIONS().filter((s) => s.id === section()).map((s) => ({ ...s, rows: s.rows.filter(applies) }));
    return SECTIONS()
      .map((s) => ({
        ...s,
        rows: s.rows.filter(
          (r) => applies(r) && (r.label.toLowerCase().includes(q) || (r.desc ?? "").toLowerCase().includes(q)),
        ),
      }))
      .filter((s) => s.rows.length);
  });

  /** A section's rows as titled boxes (boxed lists), with `advanced` rows in a
   *  last "Advanced" box. While searching: one box per section. */
  const cards = (rows: Row[]) => {
    const out: { key: string; title?: string; advanced?: boolean; rows: Row[] }[] = [];
    const adv: Row[] = [];
    for (const r of rows) {
      if (r.advanced && !searching()) { adv.push(r); continue; }
      if (!out.length || (r.group && !searching())) out.push({ key: searching() ? "all" : r.group ?? "main", title: searching() ? undefined : r.group, rows: [] });
      out[out.length - 1].rows.push(r);
    }
    if (adv.length) out.push({ key: "advanced", title: "Advanced", advanced: true, rows: adv });
    return out;
  };
  const view = createMemo(() => shown().map((s) => ({ id: s.id, label: s.label, cards: cards(s.rows) })));


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
                  <SectionIcon id={s.id} class="set-rail-ic" />
                  <span>{s.label}</span>
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
              <Show when={!searching()}>
                <div class="set-page-head">
                  <SectionIcon id={section()} class="set-page-ic" />
                  <h1 class="set-page-title">{SECTIONS().find((x) => x.id === section())?.label}</h1>
                </div>
              </Show>
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
                  {/* Keyed by id, not by object: the rows are rebuilt whenever a
                      setting changes which rows apply, and a row that stays
                      must keep its element (and keyboard focus). */}
                  <For each={view().map((v) => v.id)}>
                    {(sid) => {
                      const sec = () => view().find((v) => v.id === sid);
                      return (
                        <>
                          {/* While searching, results stay grouped so a match's
                              context (which category it belongs to) is not lost. */}
                          <Show when={searching()}>
                            <div class="side-list-head set-group">{sec()?.label}</div>
                          </Show>
                          <For each={sec()?.cards.map((c) => c.key) ?? []}>
                            {(key) => {
                              const card = () => sec()?.cards.find((c) => c.key === key);
                              return (
                                <section class="set-section" aria-labelledby={card()?.title ? `set-${sid}-${key}` : undefined}>
                                  <Show when={card()?.title}>
                                    <h2 class="set-subhead" id={`set-${sid}-${key}`}>{card()?.title}</h2>
                                  </Show>
                                  <div class="set-card">
                                    <For each={card()?.rows.map((r) => r.id) ?? []}>
                                      {(rid) => <RowById id={rid} rows={() => card()?.rows ?? []} />}
                                    </For>
                                  </div>
                                </section>
                              );
                            }}
                          </For>
                        </>
                      );
                    }}
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
