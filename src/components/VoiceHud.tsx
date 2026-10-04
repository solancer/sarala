/**
 * Voice typing UI that lives in the editor: the mic button (status bar and AI
 * composer) and the floating HUD that shows the microphone level, the words
 * heard so far, and Stop/Cancel while listening.
 *
 * The HUD's live text is aria-hidden: tentative words change constantly, so
 * screen readers hear the phases and the result through a status region
 * instead.
 */
import { For, Show, createMemo, onCleanup, onMount } from "solid-js";
import "../styles/voice.css";
import { isMac } from "../platform";
import { commandKeyLabel, shortcutLabel, voiceCommandKey, voiceEnabled, voicePause, voiceShortcut } from "../voice/config";
import {
  announcement, cancelDictation, commandMode, holding, openVoiceCommands, speaking, streamingIntoDoc, warning, initVoice, installVoiceShortcut, isListening, level, liveText, notice,
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
  const title = () =>
    isListening()
      ? `Stop voice typing (${key()}) · Esc cancels`
      : phase() === "transcribing"
        ? "Typing what you said…"
        : `Voice typing (${key()}): hold to talk, or press to start and again to stop`;
  const top = () => props.variant === "topbar";
  return (
    <Show when={voiceEnabled() && voiceSupported()}>
      <button
        class={`${top() ? "topbar-toggle voice-top" : "voice-btn"} ${props.class ?? ""}`}
        classList={{ recording: isListening(), on: !top() && isListening(), busy: phase() === "transcribing" }}
        aria-label="Voice typing"
        aria-pressed={isListening()}
        aria-keyshortcuts={voiceShortcut().replace("Ctrl", "Control")}
        title={title()}
        style={{ "--voice-level": String(isListening() ? level() : 0) }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={toggleDictation}
      >
        <MicIcon />
      </button>
    </Show>
  );
}

function Bars() {
  // Five bars scaled by the level, the outer ones less.
  const weights = [0.45, 0.75, 1, 0.75, 0.45];
  return (
    <span class="voice-bars" aria-hidden="true">
      <For each={weights}>
        {(w) => <span style={{ transform: `scaleY(${Math.max(0.12, Math.min(1, level() * 1.25 * w))})` }} />}
      </For>
    </span>
  );
}

export default function VoiceHud() {
  onMount(() => {
    void initVoice();
    onCleanup(installVoiceShortcut());
  });

  const label = createMemo(() => {
    switch (phase()) {
      case "starting": return "Starting the microphone…";
      case "loading": return "Loading the voice model. Keep talking…";
      case "listening": return commandMode() ? "Say a command" : "Listening";
      case "transcribing": return "Typing what you said…";
      default: return "";
    }
  });
  // The keys live on the buttons (Done ⏎, Cancel Esc); the hint covers the
  // rest: holding, the shortcut, and what a pause does.
  const hint = () => {
    if (phase() === "transcribing") return "";
    if (commandMode()) return `Release ${commandKeyLabel(voiceCommandKey())} to run it · nothing is typed`;
    if (holding()) return "Release the keys to finish";
    const pause = voicePause() === "type" ? " · Types each time you pause" : voicePause() === "stop" ? " · Finishes when you pause" : "";
    const cmd = voiceCommandKey() === "off" ? "" : ` · Hold ${commandKeyLabel(voiceCommandKey())} for a command`;
    return `Text appears as you speak${cmd}${pause}`;
  };

  /** The last ~140 characters, so the newest words stay visible. */
  const tail = (s: string) => (s.length > 140 ? `…${s.slice(-140)}` : s);

  return (
    <>
      <div class="sr-only voice-status" role="status" aria-live="polite">{announcement()}</div>
      <Show when={phase() !== "idle"}>
        <div class="voice-hud" classList={{ working: phase() === "transcribing", speaking: speaking(), command: commandMode() }} role="group" aria-label="Voice typing">
          <div class="voice-hud-row">
            <span class="voice-hud-icon" aria-hidden="true">
              <Show when={phase() === "transcribing" || phase() === "starting" || phase() === "loading"} fallback={<Bars />}>
                <span class="voice-spinner" />
              </Show>
            </span>
            <span class="voice-hud-titles">
              <span class="voice-hud-label">{label()}</span>
              <Show when={hint()}><span class="voice-hud-hint">{hint()}</span></Show>
            </span>
            <Show when={isListening()}>
              <button
                class="voice-hud-btn primary" aria-keyshortcuts="Enter" title="Keep the text (Return)"
                onMouseDown={(e) => e.preventDefault()} onClick={() => void stopDictation()}
              >
                Done <kbd class="voice-key" aria-hidden="true">{isMac ? "⏎" : "Enter"}</kbd>
              </button>
            </Show>
            <Show when={isListening()}>
              <button class="voice-hud-btn ghost" title="What you can say" onMouseDown={(e) => e.preventDefault()} onClick={openVoiceCommands}>
                Commands
              </button>
            </Show>
            <button
              class="voice-hud-btn" aria-keyshortcuts="Escape" title="Discard what you said (Esc)"
              onMouseDown={(e) => e.preventDefault()} onClick={() => void cancelDictation()}
            >
              Cancel <kbd class="voice-key" aria-hidden="true">Esc</kbd>
            </button>
          </div>
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
          {/* Words stream into the document itself; the HUD shows them only
              when they have nowhere to go (the text was edited meanwhile). */}
          <Show when={(commandMode() || !streamingIntoDoc()) && (liveText().committed || liveText().tentative)}>
            <p class="voice-hud-text" aria-hidden="true">
              <span>{tail(liveText().committed)}</span>
              <span class="tentative">{liveText().tentative}</span>
            </p>
          </Show>
        </div>
      </Show>
      <Show when={phase() === "idle" && notice()}>
        {(n) => (
          <div class="voice-hud voice-notice" classList={{ error: n().tone === "error" }} role="group" aria-label="Voice typing">
            <div class="voice-hud-row">
              <span class="voice-hud-icon" aria-hidden="true"><MicIcon /></span>
              <span class="voice-hud-label">{n().text}</span>
              <span class="voice-hud-spacer" />
              <Show when={n().action}>
                {(a) => (
                  <button class="voice-hud-btn primary" onClick={() => { a().run(); setNotice(null); }}>{a().label}</button>
                )}
              </Show>
              <button class="voice-hud-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}
