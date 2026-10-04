/**
 * Voice typing session: start, stop, cancel, and putting the words where the
 * caret is.
 *
 * Designed with and for people who can't easily type or see the screen (see
 * docs/VOICE-INPUT-PLAN.md §14 for the research behind each choice):
 *
 * - Shortcut: hold to talk, tap to start and tap to stop, or either (Settings).
 *   Escape cancels. Any key can be recorded; printable keys need a modifier.
 * - Every state is heard as well as seen: earcons (sounds.ts) and a screen
 *   reader status region that reads back what was typed.
 * - Hands-free: a pause can type what was said and keep listening, or stop.
 * - Spoken commands: "new paragraph", "new line", "scratch that" (remove the
 *   last dictation), "stop listening", and optional spoken punctuation.
 * - Correcting: the last dictation can be removed, or selected so the next
 *   dictation replaces it.
 * - The text goes to whatever has the caret: the active editor block (through
 *   its BlockApi, the same path as typing and paste, so the block's text stays
 *   its Markdown source and one dictation is one undo step), a text field such
 *   as the AI composer, or, with no caret, a new paragraph after the last
 *   edited block. Live words are shown in the HUD, never written into the
 *   document while they can still change.
 */
import { createSignal } from "solid-js";
import { appendColumnToActiveTable, appendRowToActiveTable, applyTableEdit, getActiveBlockApi, insertTable } from "../commands";
import {
  beginEditGroup, cancelEditGroup, doc, endEditGroup, redo, requestCaret, undo, setActive, spliceMany, targetBlockIndex, updateBlock,
} from "../store";
import { isMac } from "../platform";
import type { TableEdit } from "../tabletools";
import { applyVoiceCommands, fitDictation, isShortcutKey, matchesShortcut, tableSize, voiceAction, type VoiceAction } from "./text";
import {
  shortcutLabel, voiceCommandKey, voiceCommands, voiceDevice, voiceEnabled, voiceIdleMinutes, voiceLanguage, voiceModel, voicePause,
  voicePauseSeconds, voicePunctuation, voiceReadBack, voiceShortcut, voiceTrigger,
} from "./config";
import { playEarcon } from "./sounds";
import { voiceBackend, type PlatformInfo, type VoiceEvent } from "./transport";

export type Phase = "idle" | "starting" | "loading" | "listening" | "transcribing";

export interface Notice {
  text: string;
  tone: "info" | "error";
  action?: { label: string; run: () => void };
}

export const [phase, setPhase] = createSignal<Phase>("idle");
export const [level, setLevel] = createSignal(0);
export const [liveText, setLiveText] = createSignal({ committed: "", tentative: "" });
export const [notice, setNoticeSig] = createSignal<Notice | null>(null);
/** A problem noticed while listening (shown in the HUD, listening goes on). */
export const [warning, setWarning] = createSignal<Notice | null>(null);
/** For the screen-reader status region. */
export const [announcement, setAnnouncement] = createSignal("");
export const [setupOpen, setSetupOpen] = createSignal(false);
/** Whether this build and computer can do voice typing (null until known). */
export const [voiceSupported, setVoiceSupported] = createSignal<boolean | null>(null);
export const [platformInfo, setPlatformInfo] = createSignal<PlatformInfo | null>(null);
/** The shortcut latched listening on (tap or press-to-toggle). */
export const [latched, setLatched] = createSignal(false);
/** The shortcut is being held down (push to talk). */
export const [holding, setHolding] = createSignal(false);
/** The speaker is talking right now (voice activity). */
export const [speaking, setSpeaking] = createSignal(false);
/** When the shortcut last reached Sarala (the set-up checks it works). */
export const [shortcutSeenAt, setShortcutSeenAt] = createSignal(0);
/** Command mode (the command key is held): speech runs as a command and is
 *  never typed. */
export const [commandMode, setCommandMode] = createSignal(false);
/** A shortcut is being recorded: the current one must not fire. */
export const [recordingShortcut, setRecordingShortcut] = createSignal(false);

export const isActive = () => phase() !== "idle";
export const isListening = () => phase() === "starting" || phase() === "loading" || phase() === "listening";

export const openVoiceSetup = () => {
  setSetupOpen(true);
};

let noticeTimer: number | undefined;
export function setNotice(n: Notice | null, ms = n?.tone === "error" ? 12_000 : 5_000) {
  clearTimeout(noticeTimer);
  setNoticeSig(n);
  if (n) {
    say(n.text);
    noticeTimer = window.setTimeout(() => setNoticeSig(null), ms);
  }
}

/** Announce, even if the text is the same as last time (a live region only
 *  speaks changes). */
export function say(text: string) {
  setAnnouncement("");
  queueMicrotask(() => setAnnouncement(text));
}

/* ---------- backend events ---------- */

let listening: Promise<void> | null = null;
function ensureEvents(): Promise<void> {
  listening ??= voiceBackend().then(async (b) => {
    await b.onEvent(onEvent);
  });
  return listening;
}

/** Digital silence (exactly zero) for this long means the OS is withholding
 *  the microphone: a real one always picks up some noise. */
const DEAD_MIC_MS = 2_500;
let listenedAt = 0;
let soundSeen = false;

function onEvent(e: VoiceEvent) {
  switch (e.kind) {
    case "level":
      if (isActive() || e.level === 0) setLevel(e.level);
      if (phase() === "listening" || phase() === "loading") {
        if (e.level > 0) soundSeen = true;
        else if (!soundSeen && !warning() && performance.now() - listenedAt > DEAD_MIC_MS) {
          setWarning(silentMicHelp());
          playEarcon("error");
          say(warning()!.text);
        }
      }
      break;
    case "phase":
      if (phase() === "idle" || phase() === "transcribing") break;
      if (e.phase === "loading" || e.phase === "listening") setPhase(e.phase);
      break;
    case "text":
      if (isActive()) {
        setLiveText({ committed: e.committed, tentative: e.tentative });
        if (isListening() && !commandMode()) liveUpdate(e.committed + e.tentative);
      }
      break;
    case "speech":
      if (isListening()) onSpeech(e.speaking);
      break;
    case "error":
      if (isActive()) {
        setNotice({ text: e.message, tone: "error" });
        playEarcon("error");
      }
      break;
    default:
  }
}

export async function initVoice() {
  const b = await voiceBackend();
  const info = await b.platform().catch(() => null);
  setPlatformInfo(info);
  setVoiceSupported(info ? !info.unsupported : false);
}

/* ---------- start / stop ---------- */

const MAX_MS = 10 * 60_000;
let maxTimer: number | undefined;
let runId = 0;
/** Settles when the microphone has opened (true) or failed to (false), so a
 *  stop or cancel that arrives first waits for it instead of racing it. */
let opening: Promise<boolean> = Promise.resolve(true);
/** A pause's commit in flight; a stop waits for it so text stays in order. */
let committing: Promise<void> = Promise.resolve();

export async function startDictation(opts: { command?: boolean } = {}): Promise<void> {
  if (isActive()) return;
  if (!voiceEnabled() || !voiceModel()) {
    openVoiceSetup();
    return;
  }
  const id = ++runId;
  setNotice(null);
  setWarning(null);
  setLiveText({ committed: "", tentative: "" });
  setLevel(0);
  setSpeaking(false);
  spokeSinceCommit = false;
  setCommandMode(!!opts.command);
  startedAsCommand = !!opts.command;
  setPhase("starting");
  let opened!: (ok: boolean) => void;
  opening = new Promise((r) => (opened = r));
  await ensureEvents();
  const b = await voiceBackend();
  try {
    await b.start(voiceModel(), voiceDevice() || null, voiceLanguage() === "auto" ? null : voiceLanguage());
  } catch (err) {
    opened(false);
    if (id !== runId) return;
    reset();
    explainStartError(String((err as Error)?.message ?? err));
    return;
  }
  opened(true);
  if (id !== runId) {
    // Cancelled while the microphone was opening: close it again.
    void b.cancel();
    return;
  }
  if (phase() === "starting") setPhase("listening");
  if (!commandMode()) openLive();
  listenedAt = performance.now();
  soundSeen = false;
  playEarcon(commandMode() ? "command" : "start");
  if (!commandMode()) say(`Listening. ${finishHint()}`);
  void b.setIdle(voiceIdleMinutes());
  clearTimeout(maxTimer);
  if (isListening()) maxTimer = window.setTimeout(() => {
    if (isListening()) {
      setNotice({ text: "Stopped after 10 minutes.", tone: "info" });
      void stopDictation();
    }
  }, MAX_MS);
}

/** How to finish, for the HUD and the "Listening" announcement. */
export function finishHint(): string {
  const key = shortcutLabel(voiceShortcut());
  if (holding()) return "Release to finish, Escape to discard.";
  const pause = voicePause() === "type" ? " Text is typed when you pause." : voicePause() === "stop" ? " Pause to finish." : "";
  return `Press Return or ${key} to finish, Escape to discard.${pause}`;
}

export async function stopDictation(): Promise<void> {
  if (!isListening()) return;
  const id = runId;
  clearTimeout(maxTimer);
  clearTimeout(pauseTimer);
  setLatched(false);
  setHolding(false);
  setPhase("transcribing");
  say("Typing");
  // Stopped before the microphone finished opening: wait for it. A failed
  // start has already reset and explained itself.
  if (!(await opening) || id !== runId) return;
  await committing;
  if (id !== runId) return;
  const b = await voiceBackend();
  let text = "";
  try {
    text = await b.stop();
  } catch (err) {
    if (id === runId) {
      liveCancel();
      reset();
      setNotice({ text: String((err as Error)?.message ?? err), tone: "error" });
      playEarcon("error");
    }
    return;
  }
  if (id !== runId) return;
  const typedBefore = typedThisRun;
  const asCommand = commandMode();
  reset();
  if (asCommand) {
    runCommandText(text);
    return;
  }
  const delivered = await deliver(text);
  if (!delivered) liveCancel();
  if (delivered) playEarcon("stop");
  else if (typedBefore) {
    playEarcon("stop");
    say("Stopped listening");
  } else {
    playEarcon("cancel");
    setNotice({ text: "Didn't catch that. Nothing was typed.", tone: "info" }, 3_500);
  }
}

export async function cancelDictation(): Promise<void> {
  if (!isActive()) return;
  runId++;
  clearTimeout(maxTimer);
  clearTimeout(pauseTimer);
  const words = liveCancel(true);
  reset();
  playEarcon("cancel");
  if (words) {
    setNotice({ text: "Discarded what you said.", tone: "info", action: { label: "Restore", run: restoreDiscarded } }, 15_000);
    say(`Discarded. Press ${isMac ? "Command" : "Control"} Z to bring it back.`);
  } else {
    say("Voice typing cancelled");
  }
  await (await voiceBackend()).cancel();
}

export function toggleDictation() {
  if (isListening()) void stopDictation();
  else if (!isActive()) void startDictation();
}

function reset() {
  setHolding(false);
  setLatched(false);
  setSpeaking(false);
  setWarning(null);
  setPhase("idle");
  setLevel(0);
  setLiveText({ committed: "", tentative: "" });
  typedThisRun = false;
  setCommandMode(false);
  setHighlight("voice-live", null);
}

/* ---------- pauses (hands-free) ---------- */

const HANGOVER_MS = 450; // the engine already waited this long before "stopped"
let pauseTimer: number | undefined;
let spokeSinceCommit = false;
let typedThisRun = false;

function onSpeech(now: boolean) {
  setSpeaking(now);
  clearTimeout(pauseTimer);
  if (commandMode()) return;
  if (now) {
    spokeSinceCommit = true;
    return;
  }
  if (voicePause() === "keep" || !spokeSinceCommit) return;
  const wait = Math.max(250, voicePauseSeconds() * 1000 - HANGOVER_MS);
  pauseTimer = window.setTimeout(() => {
    if (!isListening()) return;
    if (voicePause() === "stop") void stopDictation();
    else void commitDictation();
  }, wait);
}

/** Type what was said so far and keep listening. */
export function commitDictation(): Promise<void> {
  if (phase() !== "listening") return committing;
  const id = runId;
  spokeSinceCommit = false;
  // eslint-disable-next-line solid/reactivity -- runs once per pause; reads signals at that moment
  committing = committing.then(async () => {
    const b = await voiceBackend();
    let text = "";
    try {
      text = await b.commit();
    } catch (err) {
      setWarning({ text: String((err as Error)?.message ?? err), tone: "error" });
      return;
    }
    if (id !== runId) return;
    if (await deliver(text)) {
      typedThisRun = true;
      playEarcon("typed");
    } else {
      liveCancel();
    }
    // The next stretch streams in right after this one (unless it is a command).
    if (id === runId && isListening() && !commandMode()) openLive();
  });
  return committing;
}

/**
 * Act on a finished stretch of speech: a command, or text to type. Returns
 * whether anything happened.
 */
async function deliver(raw: string): Promise<boolean> {
  if (!raw.trim()) return false;
  const action = voiceCommands() ? voiceAction(raw) : null;
  if (action) {
    // The command's own words were streamed in: take them out first.
    liveCancel();
    runAction(action, raw);
    return true;
  }
  const text = applyVoiceCommands(raw, { layout: voiceCommands(), punctuation: voicePunctuation() });
  if (!text.trim()) return false;
  await whenNotComposing();
  const typed = (liveFinish(text) ?? insertDictation(text)).trim();
  if (voiceReadBack()) {
    // What a screen reader user needs to check recognition (DictationBridge's
    // core feature); it goes nowhere for everyone else.
    say(`Typed: ${typed.replace(/\n+/g, " ")}`);
  } else {
    const words = typed.split(/\s+/).length;
    say(`Typed ${words} word${words === 1 ? "" : "s"}`);
  }
  return true;
}

/* ---------- errors and platform help ---------- */

function explainStartError(code: string) {
  playEarcon("error");
  if (code.includes("permission-denied")) {
    const os = platformInfo()?.os;
    setNotice({
      text: os === "windows"
        ? "Windows is blocking the microphone. Turn on \"Let desktop apps access your microphone\"."
        : "Microphone access is off for Sarala.",
      tone: "error",
      action: privacySettingsAction(),
    });
  } else if (code.includes("model-missing")) {
    setNotice({ text: "The voice model needs to be downloaded.", tone: "error", action: { label: "Set up", run: openVoiceSetup } });
  } else if (/microphone|device|stream/i.test(code) && platformInfo()?.sandbox === "snap") {
    setNotice({ ...snapHelp(), text: `${code} ${snapHelp().text}` });
  } else {
    setNotice({ text: code, tone: "error" });
  }
}

const SNAP_CONNECT = "snap connect sarala:audio-record";
function snapHelp(): Notice {
  return {
    text: `Allow the microphone by running: ${SNAP_CONNECT}`,
    tone: "error",
    action: { label: "Copy command", run: () => void navigator.clipboard?.writeText(SNAP_CONNECT).catch(() => {}) },
  };
}

/** What to do when the microphone delivers only silence. */
export function silentMicHelp(): Notice {
  const p = platformInfo();
  if (p?.sandbox === "snap") return { ...snapHelp(), text: `No sound from the microphone. ${snapHelp().text}` };
  if (p?.os === "windows") {
    return {
      text: "No sound from the microphone. In Windows Settings > Privacy & security > Microphone, turn on access for desktop apps, and check the input isn't muted.",
      tone: "error",
      action: privacySettingsAction(),
    };
  }
  if (p?.os === "macos" || isMac) {
    return {
      text: "No sound from the microphone. Check that Sarala is allowed under Privacy & Security > Microphone, and that the input isn't muted.",
      tone: "error",
      action: privacySettingsAction(),
    };
  }
  return { text: "No sound from the microphone. Check the input device and its volume in your sound settings.", tone: "error" };
}

/** A button that opens the OS microphone privacy settings, where there is one. */
export function privacySettingsAction(): Notice["action"] {
  const os = platformInfo()?.os ?? (isMac ? "macos" : /Windows/i.test(navigator.userAgent) ? "windows" : "linux");
  const url = os === "macos"
    ? "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone"
    : os === "windows" ? "ms-settings:privacy-microphone" : null;
  if (!url) return undefined;
  return {
    label: "Open Privacy Settings",
    run: () => void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(url)).catch(() => {}),
  };
}

/* ---------- where the words go ---------- */

type LastDictation =
  | { kind: "field"; el: HTMLTextAreaElement | HTMLInputElement; start: number; text: string }
  /** `whole: false` when the dictation spanned lines or blocks: this is its
   *  last line (what "bold that" acts on), and Scratch undoes the whole. */
  | { kind: "block"; index: number; start: number; text: string; whole?: boolean }
  | { kind: "blocks"; at: number; texts: string[] };
let last: LastDictation | null = null;
/** Something to remove or select ("scratch that", Remove Last Dictation). */
export const [hasLastDictation, setHasLastDictation] = createSignal(false);

function textField(el: Element | null): HTMLTextAreaElement | HTMLInputElement | null {
  if (el instanceof HTMLTextAreaElement) return el.disabled || el.readOnly ? null : el;
  if (el instanceof HTMLInputElement && /^(text|search|url|email)$/.test(el.type)) return el.disabled || el.readOnly ? null : el;
  return null;
}

/** Type `text` where the caret is; returns what was actually inserted. */
export function insertDictation(text: string): string {
  const field = textField(document.activeElement);
  if (field) {
    const s = field.selectionStart ?? field.value.length;
    const e = field.selectionEnd ?? s;
    const t = fitDictation(field.value.slice(0, s), field.value.slice(e), text);
    field.setRangeText(t, s, e, "end");
    // Solid's onInput handlers listen for this.
    field.dispatchEvent(new Event("input", { bubbles: true }));
    remember({ kind: "field", el: field, start: s, text: t });
    return t;
  }
  const api = getActiveBlockApi();
  const i = doc.activeIndex;
  if (api && i >= 0) {
    const src = doc.blocks[i]?.text ?? "";
    const { start, end } = api.selectionOffsets();
    const t = fitDictation(src.slice(0, start), src.slice(end), text);
    api.insertAtCaret(t);
    remember({ kind: "block", index: i, start, text: t });
    return t;
  }
  // Focus moved away (a mic button pressed with Voice Control, a switch or
  // the mouse can take it): type where the caret last was, if that text is
  // unchanged since.
  const t0 = lastTarget;
  if (t0?.kind === "field" && t0.el.isConnected && !t0.el.disabled && !t0.el.readOnly && t0.el.value === t0.value) {
    const t = fitDictation(t0.el.value.slice(0, t0.start), t0.el.value.slice(t0.end), text);
    t0.el.setRangeText(t, t0.start, t0.end, "end");
    t0.el.dispatchEvent(new Event("input", { bubbles: true }));
    remember({ kind: "field", el: t0.el, start: t0.start, text: t });
    lastTarget = null;
    return t;
  }
  if (t0?.kind === "block" && doc.blocks[t0.index]?.text === t0.text) {
    const src = t0.text;
    const t = fitDictation(src.slice(0, t0.start), src.slice(t0.end), text);
    requestCaret(t0.start + t.length);
    updateBlock(t0.index, src.slice(0, t0.start) + t + src.slice(t0.end));
    remember({ kind: "block", index: t0.index, start: t0.start, text: t });
    lastTarget = null;
    return t;
  }
  // No caret anywhere: a new paragraph after the block edited last.
  const lastIndex = targetBlockIndex();
  const at = lastIndex >= 0 ? lastIndex + 1 : doc.blocks.length;
  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  spliceMany([{ start: at, deleteCount: 0, texts: paragraphs }]);
  setActive(at + paragraphs.length - 1);
  requestCaret(paragraphs[paragraphs.length - 1].length);
  remember({ kind: "blocks", at, texts: paragraphs });
  return paragraphs.join("\n\n");
}

/** Where the caret was last, with the text it was in (to check it's still valid). */
type CaretTarget =
  | { kind: "field"; el: HTMLTextAreaElement | HTMLInputElement; start: number; end: number; value: string }
  | { kind: "block"; index: number; start: number; end: number; text: string };
let lastTarget: CaretTarget | null = null;
/** For tests and debugging. */
export const lastCaretTarget = () => lastTarget;

/** Keep `lastTarget` current while the user edits. `el` is where the caret
 *  is (or was, for a focusout: the selection is still there at that point). */
function trackCaret(el: Element | null = document.activeElement) {
  const field = textField(el);
  if (field) {
    const start = field.selectionStart ?? field.value.length;
    lastTarget = { kind: "field", el: field, start, end: field.selectionEnd ?? start, value: field.value };
    return;
  }
  const api = getActiveBlockApi();
  const i = doc.activeIndex;
  if (api && i >= 0 && el?.closest(".editor")) {
    const { start, end } = api.selectionOffsets();
    lastTarget = { kind: "block", index: i, start, end, text: doc.blocks[i]?.text ?? "" };
  }
}

/** The document as a string, to tell whether anything changed since. */
const docSig = () => doc.blocks.map((b) => b.text).join("\u0000");
/** The document right after the last multi-line dictation, then after each
 *  "…that" change to it. Scratch finds where the document is now in this
 *  chain and undoes back to before the dictation (each step is one undo). */
let lastSigs: string[] = [];

/**
 * Remember a dictation typed into a block. One line: the exact range. Several
 * lines or blocks ("new bullet …"): its last line, where it now lives (a
 * blank line splits the block, and the store activates the last part).
 */
function rememberBlockDictation(index: number, start: number, inserted: string) {
  if (!inserted.includes("\n")) {
    remember({ kind: "block", index, start, text: inserted, whole: true });
    return;
  }
  const lastLine = inserted.slice(inserted.lastIndexOf("\n") + 1);
  const split = inserted.includes("\n\n");
  const at = split && doc.activeIndex >= 0 ? doc.activeIndex : index;
  const end = split ? inserted.slice(inserted.lastIndexOf("\n\n") + 2).length : start + inserted.length;
  remember({ kind: "block", index: at, start: end - lastLine.length, text: lastLine, whole: false });
  lastSigs = [docSig()];
}

function remember(l: LastDictation) {
  last = l;
  setHasLastDictation(true);
}

/** Is the last dictation still where it was put, unchanged? */
function lastIsIntact(l: LastDictation): boolean {
  switch (l.kind) {
    case "field":
      return l.el.isConnected && l.el.value.slice(l.start, l.start + l.text.length) === l.text;
    case "block":
      return doc.blocks[l.index]?.text.slice(l.start, l.start + l.text.length) === l.text;
    case "blocks":
      return l.texts.every((t, k) => doc.blocks[l.at + k]?.text === t);
  }
}

/** Nothing for "…that" (scratch, bold, select, …) to act on any more. */
function forgetLastDictation() {
  last = null;
  setHasLastDictation(false);
}

const gone = () => {
  setNotice({ text: "The last dictation has changed since, so it was left alone.", tone: "info" });
  forgetLastDictation();
};

/** Include a space before the range that removing it would leave dangling. */
function widenOverSpace(src: string, a: number, b: number): [number, number] {
  if (a > 0 && src[a - 1] === " " && (b >= src.length || /[\s.,;:!?)]/.test(src[b]))) return [a - 1, b];
  return [a, b];
}

/** "Scratch that": take the last dictation out again (undoable). */
export function removeLastDictation() {
  const l = last;
  if (!l) {
    say("Nothing to remove");
    return;
  }
  if (l.kind === "block" && l.whole === false) {
    // A dictation over several lines or blocks was one undo step, and each
    // "…that" change since is one more.
    const steps = lastSigs.lastIndexOf(docSig()) + 1;
    if (!steps) return gone();
    // Read the text from before the dictation off the undo history, come
    // back, and remove it as a normal edit: Undo then brings it back, just
    // as after scratching a one-line dictation.
    const now = doc.blocks.map((b) => b.text);
    for (let k = 0; k < steps; k++) undo();
    const was = doc.blocks.map((b) => b.text);
    for (let k = 0; k < steps; k++) redo();
    let a = 0;
    while (a < now.length && a < was.length && now[a] === was[a]) a++;
    let z = 0;
    while (z < now.length - a && z < was.length - a && now[now.length - 1 - z] === was[was.length - 1 - z]) z++;
    spliceMany([{ start: a, deleteCount: now.length - a - z, texts: was.slice(a, was.length - z) }]);
    last = null;
    lastSigs = [];
    setHasLastDictation(false);
    playEarcon("cancel");
    say("Removed what you just said");
    return;
  }
  if (!lastIsIntact(l)) return gone();
  switch (l.kind) {
    case "field": {
      const [a, b] = widenOverSpace(l.el.value, l.start, l.start + l.text.length);
      l.el.setRangeText("", a, b, "start");
      l.el.dispatchEvent(new Event("input", { bubbles: true }));
      l.el.focus();
      break;
    }
    case "block": {
      const src = doc.blocks[l.index].text;
      const [a, b] = widenOverSpace(src, l.start, l.start + l.text.length);
      requestCaret(a);
      updateBlock(l.index, src.slice(0, a) + src.slice(b));
      break;
    }
    case "blocks":
      spliceMany([{ start: l.at, deleteCount: l.texts.length, texts: [] }]);
      break;
  }
  forgetLastDictation();
  playEarcon("cancel");
  say(`Removed: ${l.kind === "blocks" ? l.texts.join(" ") : l.text.trim()}`);
}

/** Carry out a spoken command. */
function runAction(action: Exclude<VoiceAction, null>, said: string) {
  switch (action) {
    case "scratch": return removeLastDictation();
    case "select": return selectLastDictation();
    case "bold": return transformLast((t) => `**${t}**`, "Bold");
    case "italic": return transformLast((t) => `_${t}_`, "Italic");
    case "heading": return prefixLastLine("## ", "Made a heading");
    case "bullet": return prefixLastLine("- ", "Made a list item");
    case "task": return prefixLastLine("- [ ] ", "Made a task");
    case "help": return openVoiceCommands();
    case "table": {
      const size = tableSize(said) ?? { rows: 3, cols: 2 };
      insertTable(size.rows, size.cols);
      playEarcon("typed");
      return say(`New table, ${size.rows} rows by ${size.cols} columns`);
    }
    case "tableRowAdd": return runTableGrow(appendRowToActiveTable, "Row added");
    case "tableRowAbove": return runTableEdit({ kind: "row_above" }, "Row added above");
    case "tableRowBelow": return runTableEdit({ kind: "row_below" }, "Row added below");
    case "tableRowDelete": return runTableEdit({ kind: "delete_row" }, "Row deleted");
    case "tableColAdd": return runTableGrow(appendColumnToActiveTable, "Column added");
    case "tableColBefore": return runTableEdit({ kind: "add_col", before: true }, "Column added before");
    case "tableColAfter": return runTableEdit({ kind: "add_col" }, "Column added after");
    case "tableColDelete": return runTableEdit({ kind: "delete_col" }, "Column deleted");
    case "tableRowUp": return runTableEdit({ kind: "move_row", direction: -1 }, "Row moved up");
    case "tableRowDown": return runTableEdit({ kind: "move_row", direction: 1 }, "Row moved down");
    case "tableColLeft": return runTableEdit({ kind: "move_col", direction: -1 }, "Column moved left");
    case "tableColRight": return runTableEdit({ kind: "move_col", direction: 1 }, "Column moved right");
    case "tableAlignLeft": return runTableEdit({ kind: "align", align: "left" }, "Aligned left");
    case "tableAlignCenter": return runTableEdit({ kind: "align", align: "center" }, "Aligned center");
    case "tableAlignRight": return runTableEdit({ kind: "align", align: "right" }, "Aligned right");
    case "stop":
      if (isListening()) void stopDictation();
      else say("Stopped listening");
  }
}

/** A table command, acting on the table the caret is in (a no-op, with
 *  feedback, off one): "add row above", "delete column", "align left" … */
function runTableEdit(edit: TableEdit, what: string) {
  const i = targetBlockIndex();
  const before = i >= 0 ? doc.blocks[i]?.text : undefined;
  if (before !== undefined) applyTableEdit(edit);
  if (before === undefined || doc.blocks[i]?.text === before) {
    playEarcon("cancel");
    return say("Not in a table");
  }
  playEarcon("typed");
  say(what);
}

/** "Add row"/"add column": grow the table from its edge, not from the caret. */
function runTableGrow(grow: () => void, what: string) {
  const i = targetBlockIndex();
  const before = i >= 0 ? doc.blocks[i]?.text : undefined;
  if (before !== undefined) grow();
  if (before === undefined || doc.blocks[i]?.text === before) {
    playEarcon("cancel");
    return say("Not in a table");
  }
  playEarcon("typed");
  say(what);
}

/** Rewrite the last dictation's words (bold, italic), keeping its spacing. */
function transformLast(fn: (words: string) => string, what: string) {
  const l = last;
  if (!l || l.kind === "blocks") return say(l ? `${what} works on words typed into a paragraph` : "Nothing to change yet");
  if (!lastIsIntact(l)) return gone();
  // Only the words: not the spacing, line breaks or a list/heading prefix
  // that "new bullet" or "new heading" put before them.
  const lead = l.text.match(/^\s*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/)![0].length;
  const core = l.text.slice(lead).trim();
  const trail = l.text.length - lead - core.length;
  const next = l.text.slice(0, lead) + fn(core) + l.text.slice(l.text.length - trail);
  editAsStep(() => replaceLast(l, next));
  playEarcon("typed");
  say(`${what}: ${core}`);
}

/** Make the line holding the last dictation a heading, list item or task. */
function prefixLastLine(prefix: string, what: string) {
  const l = last;
  if (!l || l.kind === "field") return say(l ? "That works in the document, not in a text box" : "Nothing to change yet");
  if (!lastIsIntact(l)) return gone();
  const index = l.kind === "block" ? l.index : l.at + l.texts.length - 1;
  const src = doc.blocks[index].text;
  const at = l.kind === "block" ? l.start + (l.text.length - l.text.trimStart().length) : 0;
  const lineStart = src.lastIndexOf("\n", at - 1) + 1;
  const line = src.slice(lineStart);
  const old = line.match(/^\s*(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)?/)![0];
  const delta = prefix.length - old.length;
  requestCaret(src.length + delta);
  editAsStep(() => updateBlock(index, src.slice(0, lineStart) + prefix + line.slice(old.length)));
  if (l.kind === "block" && l.start >= lineStart) last = { ...l, start: Math.max(lineStart + prefix.length, l.start + delta) };
  else if (l.kind === "blocks") last = { ...l, texts: l.texts.map((t, k) => (k === l.texts.length - 1 ? doc.blocks[index].text : t)) };
  playEarcon("typed");
  say(what);
}

function replaceLast(l: Extract<LastDictation, { kind: "field" | "block" }>, next: string) {
  if (l.kind === "field") {
    l.el.setRangeText(next, l.start, l.start + l.text.length, "end");
    l.el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const src = doc.blocks[l.index].text;
    requestCaret(l.start + next.length);
    updateBlock(l.index, src.slice(0, l.start) + next + src.slice(l.start + l.text.length));
  }
  last = { ...l, text: next };
}

/** Make a "…that" change as one undo step, extending the Scratch chain. */
function editAsStep(change: () => void) {
  const before = docSig();
  beginEditGroup();
  change();
  endEditGroup();
  if (lastSigs.length && lastSigs[lastSigs.length - 1] === before) lastSigs.push(docSig());
  else lastSigs = [];
}

/* ---------- commands sheet ---------- */

export const [commandsOpen, setCommandsOpen] = createSignal(false);

/** Show what can be said. Finishes a dictation first (keeping its text): the
 *  sheet takes the keyboard, and Escape there should close the sheet. */
export function openVoiceCommands() {
  if (isListening()) void stopDictation();
  setCommandsOpen(true);
}

/** Select the last dictation, so the next one (or typing) replaces it. */
export function selectLastDictation() {
  const l = last;
  if (!l) {
    say("Nothing to select");
    return;
  }
  if (!lastIsIntact(l)) return gone();
  const t = l.kind === "blocks" ? l.texts.join(" ") : l.text;
  const lead = l.kind === "blocks" ? 0 : l.text.length - l.text.trimStart().length;
  const len = l.kind === "blocks" ? 0 : l.text.trim().length;
  if (l.kind === "field") {
    l.el.focus();
    l.el.setSelectionRange(l.start + lead, l.start + lead + len);
  } else {
    const index = l.kind === "block" ? l.index : l.at + l.texts.length - 1;
    const range: [number, number] = l.kind === "block" ? [l.start + lead, l.start + lead + len] : [0, l.texts[l.texts.length - 1].length];
    if (doc.activeIndex !== index) setActive(index);
    // The block becomes editable on the next frames.
    requestAnimationFrame(() => requestAnimationFrame(() => getActiveBlockApi()?.selectRange(...range)));
  }
  say(`Selected: ${t.trim()}. Dictate again to replace it.`);
}

/* ---------- streaming into the document ----------
 *
 * While listening, the words being recognized are written straight into the
 * document at the caret (a "live region"), so the text appears where it is
 * going as it is spoken. Each update rewrites only that region, through the
 * store like any edit, so the block's text stays its Markdown source. Words
 * that may still change are marked with a CSS highlight (no extra elements).
 * Finishing replaces the region with the final text; cancelling restores what
 * was there. The whole dictation is one undo step (an edit group).
 */

type Live =
  | { kind: "block"; index: number; before: string; after: string; written: string; inserted: string; created: boolean }
  | { kind: "field"; el: HTMLTextAreaElement | HTMLInputElement; before: string; after: string; written: string; inserted: string };
let live: Live | null = null;
/** Words are streaming into the document (so the HUD needn't show them). */
export const [streamingIntoDoc, setStreamingIntoDoc] = createSignal(false);

function setHighlight(name: string, range: Range | null) {
  const reg = (globalThis as { CSS?: { highlights?: Map<string, unknown> } }).CSS?.highlights;
  const H = (globalThis as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
  if (!reg || !H) return;
  if (range) reg.set(name, new H(range));
  else reg.delete(name);
}

/** A DOM range over [start, end) text offsets of a block's editable source. */
function blockRange(index: number, start: number, end: number): Range | null {
  const el = document.querySelectorAll(".editor .page > .block")[index]?.querySelector<HTMLElement>(".source");
  if (!el || end <= start) return null;
  const range = document.createRange();
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let pos = 0;
  let started = false;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    if (!started && start <= pos + len) { range.setStart(n, start - pos); started = true; }
    if (started && end <= pos + len) { range.setEnd(n, end - pos); return range; }
    pos += len;
  }
  return null;
}

function paintLive(l: Live, name: string) {
  if (l.kind !== "block") return;
  const from = l.before.length;
  const to = from + l.inserted.length;
  // After the block has re-rendered the new text.
  requestAnimationFrame(() => setHighlight(name, blockRange(l.index, from, to)));
}

/** Start a live region where the words would go right now. */
function openLive() {
  if (live) return;
  const field = textField(document.activeElement);
  if (field) {
    const s = field.selectionStart ?? field.value.length;
    const e = field.selectionEnd ?? s;
    live = { kind: "field", el: field, before: field.value.slice(0, s), after: field.value.slice(e), written: field.value, inserted: "" };
    setStreamingIntoDoc(true);
    return;
  }
  const api = getActiveBlockApi();
  const i = doc.activeIndex;
  let target: { index: number; start: number; end: number } | null = null;
  if (api && i >= 0) {
    const { start, end } = api.selectionOffsets();
    target = { index: i, start, end };
  } else if (lastTarget?.kind === "field" && lastTarget.el.isConnected && lastTarget.el.value === lastTarget.value) {
    const t = lastTarget;
    t.el.focus();
    t.el.setSelectionRange(t.start, t.end);
    live = { kind: "field", el: t.el, before: t.value.slice(0, t.start), after: t.value.slice(t.end), written: t.value, inserted: "" };
    setStreamingIntoDoc(true);
    return;
  } else if (lastTarget?.kind === "block" && doc.blocks[lastTarget.index]?.text === lastTarget.text) {
    target = { index: lastTarget.index, start: lastTarget.start, end: lastTarget.end };
  }
  beginEditGroup();
  if (target) {
    const src = doc.blocks[target.index].text;
    live = {
      kind: "block", index: target.index, before: src.slice(0, target.start), after: src.slice(target.end),
      written: src, inserted: "", created: false,
    };
    if (doc.activeIndex !== target.index) {
      requestCaret(target.start);
      setActive(target.index);
    }
  } else {
    // No caret anywhere: a new paragraph after the block edited last.
    const last = targetBlockIndex();
    const at = last >= 0 ? last + 1 : doc.blocks.length;
    spliceMany([{ start: at, deleteCount: 0, texts: [""] }]);
    requestCaret(0);
    setActive(at);
    live = { kind: "block", index: at, before: "", after: "", written: "", inserted: "", created: true };
  }
  setStreamingIntoDoc(true);
}

function liveIntact(l: Live): boolean {
  return l.kind === "field" ? l.el.isConnected && l.el.value === l.written : doc.blocks[l.index]?.text === l.written;
}

function writeLive(l: Live, inserted: string) {
  const text = l.before + inserted + l.after;
  const caret = l.before.length + inserted.length;
  if (l.kind === "field") {
    l.el.value = text;
    l.el.setSelectionRange(caret, caret);
    l.el.dispatchEvent(new Event("input", { bubbles: true }));
    l.written = l.el.value;
  } else {
    requestCaret(caret);
    updateBlock(l.index, text);
    l.written = doc.blocks[l.index]?.text ?? text;
  }
  l.inserted = inserted;
}

/** Stop streaming (the user edited the text meanwhile); what's there stays. */
function dropLive(reverted = false) {
  live = null;
  setStreamingIntoDoc(false);
  setHighlight("voice-live", null);
  if (reverted) cancelEditGroup();
  else endEditGroup();
}

/** Show the words recognized so far in the live region. */
function liveUpdate(raw: string) {
  const l = live;
  if (!l) return;
  if (!liveIntact(l)) return dropLive();
  const inserted = raw.trim() ? fitDictation(l.before, l.after, raw) : "";
  if (inserted === l.inserted) return;
  writeLive(l, inserted);
  paintLive(l, "voice-live");
}

/**
 * Replace the live region with the final text. Returns what was typed, or
 * null when there is no usable live region (the caller types at the caret).
 */
function liveFinish(text: string): string | null {
  const l = live;
  if (!l) return null;
  if (!liveIntact(l)) {
    dropLive();
    return null;
  }
  const inserted = fitDictation(l.before, l.after, text);
  writeLive(l, inserted);
  if (l.kind === "field") remember({ kind: "field", el: l.el, start: l.before.length, text: inserted });
  else rememberBlockDictation(l.index, l.before.length, inserted);
  paintLive(l, "voice-typed");
  window.setTimeout(() => setHighlight("voice-typed", null), 1_200);
  live = null;
  setStreamingIntoDoc(false);
  setHighlight("voice-live", null);
  endEditGroup();
  return inserted;
}

/** Take the live region out again, restoring the text as it was. */
/**
 * Take the live region out again, restoring the text as it was. With
 * `recoverable` (the user pressed Escape or Cancel) words that were already
 * typed in can be brought back: Undo restores them, and so does the notice's
 * Restore button. A stray Escape must never silently lose a dictation.
 */
function liveCancel(recoverable = false): string | null {
  const l = live;
  if (!l) return null;
  if (!liveIntact(l)) {
    dropLive();
    return null;
  }
  const words = l.inserted.trim();
  if (recoverable && words) {
    // Close the group (its entry is the text before dictation), then make the
    // removal its own undo step whose "before" still has the words.
    endEditGroup();
    if (l.kind === "block") beginEditGroup();
    removeLive(l);
    discarded = l.kind === "field"
      ? { kind: "field", el: l.el, at: l.before.length, text: l.inserted, after: l.el.value }
      : { kind: "block", index: l.index, after: doc.blocks[l.index]?.text ?? null };
    dropLive();
    return words;
  }
  removeLive(l);
  // Back to exactly how it was: no undo step for it.
  dropLive(true);
  return null;
}

function removeLive(l: Live) {
  if (l.kind === "block" && l.created) spliceMany([{ start: l.index, deleteCount: 1, texts: [] }]);
  else if (l.inserted) writeLive(l, "");
}

/** What the last Escape discarded, for Restore. */
let discarded:
  | { kind: "field"; el: HTMLTextAreaElement | HTMLInputElement; at: number; text: string; after: string }
  | { kind: "block"; index: number; after: string | null }
  | null = null;

/** Bring back what Escape discarded, if nothing has changed since. */
export function restoreDiscarded() {
  const d = discarded;
  discarded = null;
  if (!d) return;
  if (d.kind === "field") {
    if (!d.el.isConnected || d.el.value !== d.after) return say("Couldn't restore: the text has changed since.");
    d.el.focus();
    d.el.setRangeText(d.text, d.at, d.at, "end");
    d.el.dispatchEvent(new Event("input", { bubbles: true }));
  } else {
    const now = d.index < doc.blocks.length ? doc.blocks[d.index]?.text ?? null : null;
    if (now !== d.after && !(d.after === null && now === null)) return say("Couldn't restore: the text has changed since.");
    undo();
  }
  say("Restored what you said");
}

/* ---------- the command key ----------
 *
 * One key, pressed on its own (Right Option / Right Ctrl by default; Settings
 * > Voice > Command key):
 *
 * - tap: start or stop dictation;
 * - hold: say a command. While dictating, what was said so far is typed first,
 *   then the speech until release runs as a command and is never typed. When
 *   not dictating, it is a one-shot command ("make that bold").
 *
 * Holding it is a quasimode: you are only in command mode while your finger
 * says so, so the mode can't be forgotten. Pressing another key meanwhile
 * means the key was a modifier for typing (Option+E for an accent), and it
 * backs off. Spoken commands work without it, for anyone who can't hold keys.
 */

const CMD_HOLD_MS = 280;
let cmdDown = false;
let cmdHeld = false;
let cmdOther = false;
let cmdAt = 0;
let cmdTimer: number | undefined;

/** Only that key: no other modifier held with it. */
function aloneKey(e: KeyboardEvent, code: string): boolean {
  const others = { alt: e.altKey, ctrl: e.ctrlKey, meta: e.metaKey, shift: e.shiftKey };
  if (/^Alt/.test(code)) others.alt = false;
  if (/^Control/.test(code)) others.ctrl = false;
  if (/^Meta/.test(code)) others.meta = false;
  return !others.alt && !others.ctrl && !others.meta && !others.shift;
}

function commandKeyDown(e: KeyboardEvent): boolean {
  const key = voiceCommandKey();
  if (key === "off") return false;
  if (e.code === key) {
    if (e.repeat || cmdDown || !aloneKey(e, key)) return true;
    cmdDown = true;
    cmdOther = false;
    cmdAt = performance.now();
    clearTimeout(cmdTimer);
    cmdTimer = window.setTimeout(() => {
      if (!cmdDown || cmdOther) return;
      cmdHeld = true;
      enterCommand();
    }, CMD_HOLD_MS);
    return true;
  }
  if (cmdDown && !cmdHeld) {
    // Another key with it: it is being used to type a character.
    cmdOther = true;
    clearTimeout(cmdTimer);
  }
  return false;
}

function commandKeyUp(e: KeyboardEvent): boolean {
  const key = voiceCommandKey();
  if (key === "off" || e.code !== key || !cmdDown) return false;
  cmdDown = false;
  clearTimeout(cmdTimer);
  if (cmdHeld) {
    cmdHeld = false;
    void exitCommand();
  } else if (!cmdOther && performance.now() - cmdAt < CMD_HOLD_MS) {
    toggleDictation();
  }
  return true;
}

/** Hold began: type what was said so far, then listen for a command. */
function enterCommand() {
  if (isListening()) {
    if (commandMode()) return;
    setCommandMode(true);
    setLiveText({ committed: "", tentative: "" });
    playEarcon("command");
    // If nothing has been typed yet this session, including just now, a
    // stale "last dictation" from before it started must not be what the
    // command that follows ("scratch that", "make that bold", …) silently
    // acts on: the engine missing what was just said must read as nothing
    // to act on, never as licence to reach back and change older work.
    void commitDictation().then(() => {
      if (!typedThisRun) forgetLastDictation();
    });
  } else if (!isActive()) {
    void startDictation({ command: true });
  }
}

/** Hold ended: run what was said as a command, then go back to dictating. */
async function exitCommand() {
  if (!commandMode()) return;
  // A one-shot command (started from idle) ends the session.
  if (oneShot()) return stopDictation();
  const id = runId;
  // eslint-disable-next-line solid/reactivity -- runs once on release; reads signals at that moment
  committing = committing.then(async () => {
    const b = await voiceBackend();
    let text = "";
    try {
      text = await b.commit();
    } catch (err) {
      setWarning({ text: String((err as Error)?.message ?? err), tone: "error" });
    }
    if (id !== runId) return;
    setCommandMode(false);
    setLiveText({ committed: "", tentative: "" });
    runCommandText(text);
    if (isListening()) openLive();
  });
  return committing;
}

/** Started in command mode from idle: the session is just this command. */
let startedAsCommand = false;
const oneShot = () => commandMode() && startedAsCommand;

/** Run what was said in command mode. Nothing is ever typed from it. */
function runCommandText(raw: string) {
  const said = raw.trim();
  if (!said) {
    playEarcon("cancel");
    say("No command heard");
    return;
  }
  const action = voiceAction(said);
  if (action) return runAction(action, said);
  const words = said.toLowerCase().replace(/[^\p{L}\s]/gu, "").trim();
  if (words === "undo") {
    undo();
    playEarcon("cancel");
    return say("Undone");
  }
  if (words === "redo") {
    redo();
    playEarcon("typed");
    return say("Redone");
  }
  // Layout on its own: "new paragraph", "new line", "new bullet", "new task".
  const layout = applyVoiceCommands(said);
  if (layout !== said && /^[\s\uE001-\uE003]+$/.test(layout)) {
    insertLayout(layout);
    playEarcon("typed");
    return say(said.replace(/[.!?]+$/, ""));
  }
  playEarcon("error");
  setNotice({
    text: `“${said}” isn't a command.`,
    tone: "info",
    action: { label: "Show commands", run: openVoiceCommands },
  }, 6_000);
}

/** Insert line breaks or a list/heading prefix at the caret. */
function insertLayout(layout: string) {
  if (/[\uE001-\uE003]/.test(layout)) {
    insertDictation(layout);
    return;
  }
  const field = textField(document.activeElement);
  if (field) {
    const s0 = field.selectionStart ?? field.value.length;
    field.setRangeText(layout.includes("\n\n") ? "\n\n" : "\n", s0, field.selectionEnd ?? s0, "end");
    field.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }
  getActiveBlockApi()?.insertAtCaret(layout.includes("\n\n") ? "\n\n" : "\n");
}

/* ---------- IME ---------- */

let composing = false;
const composeWaiters: (() => void)[] = [];
function whenNotComposing(): Promise<void> {
  return composing ? new Promise((r) => composeWaiters.push(r)) : Promise.resolve();
}

/* ---------- shortcut ---------- */

const HOLD_MS = 400;
let holdStart = 0;

function onKeyDown(e: KeyboardEvent) {
  if (!voiceEnabled() || voiceSupported() === false || recordingShortcut() || e.isComposing || composing) return;
  if (commandKeyDown(e)) return;
  if (isActive() && e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    void cancelDictation();
    return;
  }
  // Return finishes and keeps the text (Escape discards): the usual
  // confirm/cancel pair. While words are still arriving it does only that:
  // no line break in the document, no message sent from the AI composer.
  if (isActive() && e.key === "Enter" && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    e.stopPropagation();
    if (isListening()) void stopDictation();
    return;
  }
  if (!matchesShortcut(e, voiceShortcut())) return;
  // Also stops Option+Space typing a non-breaking space.
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat) return;
  setShortcutSeenAt(Date.now());
  if (!isActive()) {
    if (voiceTrigger() !== "toggle") {
      setHolding(true);
      holdStart = performance.now();
    } else {
      setLatched(true);
    }
    void startDictation();
  } else if (isListening()) {
    void stopDictation();
  }
}

function onKeyUp(e: KeyboardEvent) {
  if (commandKeyUp(e)) return;
  if (!holding() || !isShortcutKey(e, voiceShortcut())) return;
  setHolding(false);
  if (voiceTrigger() === "hold" || performance.now() - holdStart >= HOLD_MS) void stopDictation();
  else if (isActive()) setLatched(true); // a tap: keep listening until the next press
}

/** Losing the window mid-hold would lose the key-up. */
function onBlur() {
  clearTimeout(cmdTimer);
  cmdDown = false;
  if (cmdHeld) {
    cmdHeld = false;
    void exitCommand();
  }
  if (!holding()) return;
  setHolding(false);
  if (voiceTrigger() === "hold") void stopDictation();
  else if (isActive()) setLatched(true);
}

export function installVoiceShortcut(): () => void {
  const start = () => (composing = true);
  const end = () => {
    composing = false;
    composeWaiters.splice(0).forEach((r) => r());
  };
  // Field values change after keydown/input; read the caret once things settle.
  const track = () => queueMicrotask(() => trackCaret());
  // selectionchange arrives a moment later; focus can already have moved
  // (pressing the mic button right after clicking into text). focusout runs
  // while the caret is still in place.
  const leaving = (e: FocusEvent) => trackCaret(e.target as Element);
  document.addEventListener("selectionchange", track);
  document.addEventListener("input", track, true);
  document.addEventListener("focusout", leaving, true);
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  document.addEventListener("compositionstart", start, true);
  document.addEventListener("compositionend", end, true);
  return () => {
    document.removeEventListener("selectionchange", track);
    document.removeEventListener("input", track, true);
    document.removeEventListener("focusout", leaving, true);
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
    document.removeEventListener("compositionstart", start, true);
    document.removeEventListener("compositionend", end, true);
  };
}
