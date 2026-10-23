/**
 * Voice typing UI that lives in the editor: the mic button (status bar and AI
 * composer) and the floating HUD that shows the microphone level, the words
 * heard so far, and Stop/Cancel while listening.
 *
 * The HUD's live text is aria-hidden: tentative words change constantly, so
 * screen readers hear the phases and the result through a status region
 * instead.
 */
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js";
import "../styles/voice.css";
import { isMac } from "../platform";
import {
  HINT_RUNS, commandKeyLabel, countVoiceRun, shortcutLabel, voiceCommandKey, voiceEnabled, voiceHintRuns, voiceModel, voicePause, voiceShortcut,
  voiceShowButton,
} from "../voice/config";
import {
  announcement, cancelDictation, commandMode, holding, openVoiceSetup, pauseNotice, resumeNotice, speaking, streamingIntoDoc, warning, initVoice, installVoiceShortcut, isListening, level, liveText, notice,
  phase, setNotice, stopDictation, toggleDictation, voiceSupported,
} from "../voice/session";

export function MicIcon() {
  return (
    <svg class="voice-mic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" />
    </svg>
  );
}

/**
 * Mic toggle. Keeps the caret where it is (no focus on mousedown), so the
 * words land where the user was typing.
 *
 * `variant="topbar"` is the main one, beside Focus mode: the same component
 * as its neighbours (topbar-toggle) at rest, solid red while listening so the
 * state can't be missed. The default variant sits inside text boxes (the AI
 * composer, the set-up's try-it field).
 */
export function VoiceButton(props: { class?: string; variant?: "topbar" | "inline" }) {
  const key = () => shortcutLabel(voiceShortcut());
  const top = () => props.variant === "topbar";
  // Before set-up, the top bar's button is the way in (with a setup-needed
  // dot, like the assistant's); text-box buttons only appear once it's on.
  const setUp = () => voiceEnabled() && !!voiceModel();
  const shown = () => voiceSupported() === true && (top() ? voiceShowButton() : setUp());
  const title = () =>
    !setUp()
      ? "Set up voice typing: speech to text on this computer, nothing uploaded"
      : isListening()
        ? `Stop voice typing (${key()}) · Esc cancels`
        : phase() === "transcribing"
          ? "Typing what you said…"
          : `Voice typing (${key()}): hold to talk, or press to start and again to stop`;
  return (
    <Show when={shown()}>
      <button
        class={`${top() ? "topbar-toggle voice-top" : "voice-btn"} ${props.class ?? ""}`}
        classList={{ recording: isListening(), on: !top() && isListening(), busy: phase() === "transcribing", "needs-setup": !setUp() }}
        aria-label={setUp() ? "Voice typing" : "Set up voice typing"}
        aria-pressed={setUp() ? isListening() : undefined}
        aria-haspopup={setUp() ? undefined : "dialog"}
        aria-keyshortcuts={setUp() ? voiceShortcut().replace("Ctrl", "Control") : undefined}
        title={title()}
        style={{ "--voice-level": String(isListening() ? level() : 0) }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => (setUp() ? toggleDictation() : openVoiceSetup())}
      >
        <MicIcon />
        <Show when={!setUp()}><span class="voice-setup-dot" aria-hidden="true" /></Show>
      </button>
    </Show>
  );
}

/** Bars in the pill's waveform: the last few level readings, newest on the
 *  right, so speech scrolls through like a waveform rather than one bar
 *  pumping. */
const WAVE = 9;

function Wave() {
  const [history, setHistory] = createSignal<number[]>(Array(WAVE).fill(0));
  createEffect(on(level, (l) => setHistory((h) => [...h.slice(1), l])));
  return (
    <span class="voice-wave" aria-hidden="true">
      <For each={history()}>
        {(l) => <span style={{ transform: `scaleY(${Math.max(0.14, Math.min(1, l * 1.5))})` }} />}
      </For>
    </span>
  );
}

/**
 * Keep the place the words go visible: if the caret (or the focused field)
 * is behind the pill, scroll it up clear of it (WCAG 2.4.11, focus not
 * obscured). Only the nearest scrolling ancestor moves, and only as far as
 * needed.
 */
function keepClear(hud: HTMLElement | undefined) {
  if (!hud) return;
  const top = hud.getBoundingClientRect().top;
  const sel = getSelection();
  const anchor = sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement ?? null;
  // The caret's own line box. A collapsed caret can report an empty rect
  // (Chromium, end of a line); then use the line boxes, then the element the
  // caret is in. Never a big container: that would scroll by its height.
  const range = sel?.rangeCount ? sel.getRangeAt(0) : null;
  let bottom = range ? range.getBoundingClientRect().bottom : 0;
  if (range && !bottom) bottom = [...range.getClientRects()].at(-1)?.bottom ?? 0;
  const field = document.activeElement as HTMLElement | null;
  if (!bottom && field && /^(INPUT|TEXTAREA)$/.test(field.tagName)) bottom = field.getBoundingClientRect().bottom;
  if (!bottom && anchor) {
    const r = anchor.getBoundingClientRect();
    if (r.height < window.innerHeight / 3) bottom = r.bottom;
  }
  if (!bottom) return;
  const gap = 16;
  const over = bottom - (top - gap);
  // Only as far as needed, and never more than a screen (a stale rect).
  if (over <= 0 || over > window.innerHeight) return;
  let el = anchor ?? field;
  while (el && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  (el ?? document.scrollingElement)?.scrollBy({ top: over, behavior: "auto" });
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * The recording pill, bottom centre: a status dot, the waveform, a timer, and
 * two controls (finish, discard). It stays small and quiet; for the first few
 * dictations a line under it says how to finish and discard, then it doesn't.
 * Keys still do everything (shortcut or Return finishes, Escape discards), and
 * the screen-reader status region announces each phase and what was typed.
 */
export default function VoiceHud() {
  onMount(() => {
    void initVoice();
    onCleanup(installVoiceShortcut());
  });

  // Time since listening began; counts the dictation for the first-run hints.
  const [startedAt, setStartedAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  let tick: number | undefined;
  createEffect(on(phase, (p, prev) => {
    if (p === "listening" && prev !== "listening") setStartedAt(Date.now());
    if (p !== "idle" && (prev === "idle" || prev === undefined)) void countVoiceRun();
    clearInterval(tick);
    if (p !== "idle") tick = window.setInterval(() => setNow(Date.now()), 500);
  }));
  onCleanup(() => clearInterval(tick));
  const elapsed = () => (startedAt() ? Math.max(0, now() - startedAt()) : 0);

  // What the pill says when it isn't showing the waveform; also its name for
  // assistive tech.
  const label = createMemo(() => {
    switch (phase()) {
      case "starting": return "Starting the microphone…";
      case "loading": return "Loading the model. Keep talking…";
      case "listening": return commandMode() ? "Say a command" : "Listening";
      case "transcribing": return "Typing…";
      default: return "";
    }
  });
  const key = () => shortcutLabel(voiceShortcut());
  const showHints = () => voiceHintRuns() <= HINT_RUNS;
  // Only the essentials, and only while they're new.
  const hint = () => {
    if (phase() === "transcribing" || !showHints()) return "";
    if (commandMode()) return `Release ${commandKeyLabel(voiceCommandKey())} to run it · nothing is typed`;
    if (holding()) return `Release ${key()} to finish · Esc discards`;
    const pause = voicePause() === "type" ? " · Types each time you pause" : voicePause() === "stop" ? " · Finishes when you pause" : "";
    const cmd = voiceCommandKey() === "off" ? "" : ` · Hold ${commandKeyLabel(voiceCommandKey())} for a command`;
    return `${key()} or ${isMac ? "⏎" : "Enter"} finishes · Esc discards${cmd}${pause}`;
  };

  let hudEl: HTMLDivElement | undefined;
  // When listening starts and as words arrive, keep the insertion point
  // out from under the pill.
  createEffect(on([phase, liveText, warning], () => {
    if (phase() !== "idle") requestAnimationFrame(() => keepClear(hudEl));
  }));

  /** The last ~140 characters, so the newest words stay visible. */
  const tail = (s: string) => (s.length > 140 ? `…${s.slice(-140)}` : s);
  const waiting = () => phase() === "starting" || phase() === "loading" || phase() === "transcribing";

  return (
    <>
      <div class="sr-only voice-status" role="status" aria-live="polite">{announcement()}</div>
      <Show when={phase() !== "idle"}>
        <div
          ref={hudEl}
          class="voice-hud"
          classList={{ working: phase() === "transcribing", speaking: speaking(), command: commandMode(), holding: holding() }}
          role="group" aria-label={`Voice typing: ${label()}`}
        >
          {/* Words stream into the document itself; the panel shows them only
              when they have nowhere to go (the text was edited meanwhile). */}
          <Show when={(commandMode() || !streamingIntoDoc()) && (liveText().committed || liveText().tentative)}>
            <p class="voice-hud-text" aria-hidden="true">
              <span>{tail(liveText().committed)}</span>
              <span class="tentative">{liveText().tentative}</span>
            </p>
          </Show>
          <Show when={warning()}>
            {(w) => (
              <div class="voice-hud-warning">
                <span>{w().text}</span>
                <Show when={w().action}>
                  {(a) => <button class="voice-hud-btn" onMouseDown={(e) => e.preventDefault()} onClick={() => a().run()}>{a().label}</button>}
                </Show>
              </div>
            )}
          </Show>
          <div class="voice-pill">
            <Show
              when={!waiting()}
              fallback={
                <>
                  <span class="voice-spinner" aria-hidden="true" />
                  <span class="voice-hud-label">{label()}</span>
                </>
              }
            >
              <Show
                when={!commandMode()}
                fallback={
                  <>
                    <span class="voice-cmd-mark" aria-hidden="true">⌘</span>
                    <span class="voice-hud-label">{label()}</span>
                  </>
                }
              >
                <span class="voice-dot" aria-hidden="true" />
                {/* The state in words, for assistive tech and tests; the dot,
                    waveform and timer say it visually. */}
                <span class="voice-hud-label sr-only">{label()}</span>
                <Wave />
                <span class="voice-time" aria-hidden="true">{clock(elapsed())}</span>
              </Show>
            </Show>
            {/* Finish: not while holding (letting go finishes) or typing. */}
            <Show when={isListening() && !holding() && !commandMode()}>
              <button
                class="voice-pill-btn finish" aria-keyshortcuts="Enter" aria-label="Finish and keep the text"
                title={`Finish and keep the text (${key()} or ${isMac ? "Return" : "Enter"})`}
                onMouseDown={(e) => e.preventDefault()} onClick={() => void stopDictation()}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
              </button>
            </Show>
            <button
              class="voice-pill-btn discard" aria-keyshortcuts="Escape" aria-label="Discard what you said" title="Discard what you said (Esc)"
              onMouseDown={(e) => e.preventDefault()} onClick={() => void cancelDictation()}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>
            </button>
          </div>
          <Show when={hint()}><p class="voice-hud-hint">{hint()}</p></Show>
        </div>
      </Show>
      <Show when={phase() === "idle" && notice()}>
        {(n) => (
          <div
            class="voice-hud voice-notice" classList={{ error: n().tone === "error" }} role="group" aria-label="Voice typing"
            onMouseEnter={pauseNotice} onMouseLeave={resumeNotice} onFocusIn={pauseNotice} onFocusOut={resumeNotice}
          >
            <div class="voice-pill voice-notice-pill">
              <span class="voice-hud-icon" aria-hidden="true"><MicIcon /></span>
              <span class="voice-hud-label">{n().text}</span>
              <Show when={n().action}>
                {(a) => (
                  <button class="voice-hud-btn primary" onClick={() => { a().run(); setNotice(null); }}>{a().label}</button>
                )}
              </Show>
              <button class="voice-pill-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6.5 6.5l11 11M17.5 6.5l-11 11" /></svg>
              </button>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
