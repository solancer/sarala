/**
 * Voice typing preferences (persisted through settings.ts). Off until the
 * user opts in; nothing loads, listens or downloads before that.
 */
import { createSignal } from "solid-js";
import { getSetting, setSetting } from "../settings";
import { isMac } from "../platform";
import { canonicalShortcut, shortcutLabel as labelFor } from "./text";

export interface ShortcutOption {
  id: string;
  /** Why to pick (or avoid) it. */
  note?: string;
}

/**
 * Suggested shortcuts; any other can be recorded in Settings. Chosen to avoid
 * the app's own shortcuts, the screen readers' keys (VoiceOver: Control+Option;
 * NVDA/JAWS: Insert, Caps Lock), and common global hotkeys: Option+Space is
 * Alfred's default and is taken by the ChatGPT app, Control+Space switches
 * input sources on macOS and toggles input methods on Windows and Linux, and
 * Cmd/Win+Space are system shortcuts.
 */
export const SHORTCUTS: ShortcutOption[] = isMac
  ? [
      { id: "Shift+Meta+D" },
      { id: "Alt+Space", note: "Alfred and the ChatGPT app also use it" },
      { id: "Ctrl+Alt+Space" },
      { id: "F13", note: "On full-size keyboards" },
    ]
  : [
      { id: "Ctrl+Alt+Space" },
      { id: "Ctrl+Shift+D" },
      { id: "F2" },
      { id: "Insert", note: "Not with NVDA or JAWS, which use it" },
    ];

export const DEFAULT_SHORTCUT = SHORTCUTS[0].id;

/**
 * The command key, pressed on its own: tap to start or stop dictation, hold
 * to say a command (while dictating, what was said so far is typed first).
 * Right-hand modifiers, because they are rarely used alone and never needed
 * for typing: not Right Alt on Windows/Linux (AltGr types characters in many
 * layouts), not Caps Lock or Insert (NVDA and JAWS use them), not Fn/Globe
 * (it can't be read reliably). A key code, matched with KeyboardEvent.code.
 */
export const COMMAND_KEYS: { id: string; label: string }[] = isMac
  ? [{ id: "AltRight", label: "Right Option" }, { id: "MetaRight", label: "Right Command" }, { id: "off", label: "Off" }]
  : [{ id: "ControlRight", label: "Right Ctrl" }, { id: "off", label: "Off" }];
export const commandKeyLabel = (id: string) => COMMAND_KEYS.find((k) => k.id === id)?.label ?? id;
export const shortcutLabel = (id: string) => labelFor(id, isMac);

/** How the shortcut behaves. "both": hold to talk, or tap to start and tap to
 *  stop. The single-mode options help when holding keys is hard, or when a
 *  long press is easy to make by accident. */
export type TriggerMode = "both" | "toggle" | "hold";
export const TRIGGER_OPTIONS = [
  { value: "both", label: "Hold or tap" },
  { value: "toggle", label: "Press to toggle" },
  { value: "hold", label: "Hold only" },
];

/** What a pause in speech does. "keep": nothing (pauses never end a
 *  dictation); "type": type what was said and keep listening (hands-free);
 *  "stop": type it and stop. */
export type PauseMode = "keep" | "type" | "stop";
export const PAUSE_OPTIONS = [
  { value: "keep", label: "Keep listening" },
  { value: "type", label: "Type, keep going" },
  { value: "stop", label: "Type and stop" },
];
export const PAUSE_SECONDS = [
  { value: "1", label: "1 second" },
  { value: "2", label: "2 seconds" },
  { value: "3", label: "3 seconds" },
  { value: "5", label: "5 seconds" },
];

/** The model suggested first: Parakeet streams and is the most accurate
 *  English model; everyone else gets multilingual Whisper. */
export const recommendedModel = () =>
  (typeof navigator !== "undefined" && /^en\b/i.test(navigator.language ?? "en")) ? "parakeet-en" : "whisper-small";

export const IDLE_OPTIONS = [
  { value: "0", label: "After each use" },
  { value: "5", label: "After 5 minutes" },
  { value: "15", label: "After 15 minutes" },
  { value: "60", label: "After an hour" },
  { value: "-1", label: "Never" },
];

/** Language hints for multilingual models. Others ignore it. */
export const LANGUAGES = [
  ["auto", "Automatic"], ["en", "English"], ["es", "Spanish"], ["fr", "French"], ["de", "German"],
  ["it", "Italian"], ["pt", "Portuguese"], ["nl", "Dutch"], ["pl", "Polish"], ["ru", "Russian"], ["uk", "Ukrainian"],
  ["tr", "Turkish"], ["ar", "Arabic"], ["hi", "Hindi"], ["kn", "Kannada"], ["ta", "Tamil"], ["te", "Telugu"],
  ["zh", "Chinese"], ["ja", "Japanese"], ["ko", "Korean"], ["vi", "Vietnamese"], ["id", "Indonesian"],
].map(([value, label]) => ({ value, label }));

export const [voiceEnabled, setVoiceEnabledSig] = createSignal(false);
/** The chosen model id; empty until set up. */
export const [voiceModel, setVoiceModelSig] = createSignal("");
/** Input device name; empty is the system default. */
export const [voiceDevice, setVoiceDeviceSig] = createSignal("");
export const [voiceLanguage, setVoiceLanguageSig] = createSignal("auto");
export const [voiceShortcut, setVoiceShortcutSig] = createSignal(DEFAULT_SHORTCUT);
export const [voiceTrigger, setVoiceTriggerSig] = createSignal<TriggerMode>("both");
export const [voicePause, setVoicePauseSig] = createSignal<PauseMode>("keep");
export const [voiceCommandKey, setVoiceCommandKeySig] = createSignal(COMMAND_KEYS[0].id);
export const [voicePauseSeconds, setVoicePauseSecondsSig] = createSignal(2);
/** Short sounds when listening starts and stops: the state without looking. */
export const [voiceSounds, setVoiceSoundsSig] = createSignal(true);
/** Screen readers read out what was typed (it never reaches anyone else). */
export const [voiceReadBack, setVoiceReadBackSig] = createSignal(true);
/** "new paragraph", "new line", "scratch that", "stop listening". */
export const [voiceCommands, setVoiceCommandsSig] = createSignal(true);
/** "comma", "period", "question mark"... */
export const [voicePunctuation, setVoicePunctuationSig] = createSignal(false);
/** Minutes before the model is unloaded; -1 keeps it loaded. */
export const [voiceIdleMinutes, setVoiceIdleMinutesSig] = createSignal(5);

/** Called from settings.ts once persisted settings are loaded. */
export function hydrateVoiceSettings() {
  setVoiceEnabledSig(getSetting("voiceEnabled", false));
  setVoiceModelSig(getSetting("voiceModel", ""));
  setVoiceDeviceSig(getSetting("voiceDevice", ""));
  setVoiceLanguageSig(getSetting("voiceLanguage", "auto"));
  setVoiceShortcutSig(canonicalShortcut(getSetting("voiceShortcut", DEFAULT_SHORTCUT) || DEFAULT_SHORTCUT));
  const trig = getSetting<string>("voiceTrigger", "both");
  setVoiceTriggerSig(TRIGGER_OPTIONS.some((o) => o.value === trig) ? (trig as TriggerMode) : "both");
  const pause = getSetting<string>("voicePause", "keep");
  setVoicePauseSig(PAUSE_OPTIONS.some((o) => o.value === pause) ? (pause as PauseMode) : "keep");
  setVoicePauseSecondsSig(getSetting("voicePauseSeconds", 2));
  const ck = getSetting<string>("voiceCommandKey", COMMAND_KEYS[0].id);
  setVoiceCommandKeySig(COMMAND_KEYS.some((k) => k.id === ck) ? ck : COMMAND_KEYS[0].id);
  setVoiceSoundsSig(getSetting("voiceSounds", true));
  setVoiceReadBackSig(getSetting("voiceReadBack", true));
  setVoiceCommandsSig(getSetting("voiceCommands", true));
  setVoicePunctuationSig(getSetting("voicePunctuation", false));
  setVoiceIdleMinutesSig(getSetting("voiceIdleMinutes", 5));
}

export async function setVoiceEnabled(on: boolean) {
  setVoiceEnabledSig(on);
  await setSetting("voiceEnabled", on);
}
export async function setVoiceModel(id: string) {
  setVoiceModelSig(id);
  await setSetting("voiceModel", id);
}
export async function setVoiceDevice(name: string) {
  setVoiceDeviceSig(name);
  await setSetting("voiceDevice", name);
}
export async function setVoiceLanguage(code: string) {
  setVoiceLanguageSig(code);
  await setSetting("voiceLanguage", code);
}
export async function setVoiceShortcut(id: string) {
  setVoiceShortcutSig(canonicalShortcut(id));
  await setSetting("voiceShortcut", canonicalShortcut(id));
}
export async function setVoiceIdleMinutes(m: number) {
  setVoiceIdleMinutesSig(m);
  await setSetting("voiceIdleMinutes", m);
}
export async function setVoiceTrigger(m: TriggerMode) {
  setVoiceTriggerSig(m);
  await setSetting("voiceTrigger", m);
}
export async function setVoicePause(m: PauseMode) {
  setVoicePauseSig(m);
  await setSetting("voicePause", m);
}
export async function setVoicePauseSeconds(n: number) {
  setVoicePauseSecondsSig(n);
  await setSetting("voicePauseSeconds", n);
}
export async function setVoiceSounds(on: boolean) {
  setVoiceSoundsSig(on);
  await setSetting("voiceSounds", on);
}
export async function setVoiceReadBack(on: boolean) {
  setVoiceReadBackSig(on);
  await setSetting("voiceReadBack", on);
}
export async function setVoiceCommands(on: boolean) {
  setVoiceCommandsSig(on);
  await setSetting("voiceCommands", on);
}
export async function setVoicePunctuation(on: boolean) {
  setVoicePunctuationSig(on);
  await setSetting("voicePunctuation", on);
}
export async function setVoiceCommandKey(id: string) {
  setVoiceCommandKeySig(id);
  await setSetting("voiceCommandKey", id);
}
