/**
 * Voice typing set-up, in four steps: language (which picks the model),
 * microphone (permission, choice and a live level check), shortcut, and try
 * it. This is the opt-in: nothing is downloaded or listened to before the
 * user goes through it.
 *
 * Cheap checks come first and the one long wait runs behind them: the model
 * starts downloading when the language step is done and keeps going through
 * the microphone and shortcut steps, so a denied or silent microphone shows
 * up in seconds, not after a 500 MB download. The microphone step explains
 * the system prompt before showing it, with one button that opens it (Apple
 * HIG, "Accessing private data").
 */
import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup } from "solid-js";
import ModalFrame from "./ModalFrame";
import { MicIcon, VoiceButton } from "./VoiceHud";
import {
  COMMAND_KEYS, LANGUAGES, PAUSE_OPTIONS, commandKeyLabel, recommendedFor, setVoiceCommandKey, setVoiceEnabled, setVoiceLanguage,
  setVoiceModel, setVoicePause, shortcutLabel, voiceCommandKey, voiceDevice, voiceLanguage, voiceModel, voicePause, voiceShortcut,
  type PauseMode,
} from "../voice/config";
import {
  platformInfo, privacySettingsAction, setSetupOpen, setupOpen, shortcutSeenAt, voiceSupported,
} from "../voice/session";
import { VoiceDeviceRow, VoiceShortcutRow, VoiceTriggerRow } from "./VoiceSettings";
import { closeSettings, isSettingsOpen, openSettings } from "./SettingsModal";
import { formatSize, voiceBackend, type VoiceModel } from "../voice/transport";

type Step = "language" | "mic" | "shortcut" | "try";
const STEPS: { id: Step; label: string }[] = [
  { id: "language", label: "Language" },
  { id: "mic", label: "Microphone" },
  { id: "shortcut", label: "Shortcut" },
  { id: "try", label: "Try it" },
];

/** The model download, running behind the steps. */
type Download =
  | { state: "idle" }
  | { state: "running"; model: string; received: number; total: number; verifying: boolean }
  | { state: "done"; model: string }
  | { state: "error"; model: string; message: string };

/** Microphone step: "ask" explains the system prompt before it is shown. */
type Mic = "checking" | "ask" | "asking" | "denied" | "ok" | "error";

/** Loading the model into memory, once it is on disk. */
type Ready = "waiting" | "preparing" | "ready" | "error";

const [step, setStep] = createSignal<Step>("language");
const [models, setModels] = createSignal<VoiceModel[]>([]);
const [lang, setLang] = createSignal("auto");
const [chosen, setChosen] = createSignal("");
/** The user picked a model themselves: a language change no longer overrides it. */
const [picked, setPicked] = createSignal(false);
const [showAll, setShowAll] = createSignal(false);
const [dl, setDl] = createSignal<Download>({ state: "idle" });
const [mic, setMic] = createSignal<Mic>("checking");
const [micError, setMicError] = createSignal("");
const [micLevel, setMicLevel] = createSignal(0);
/** Something louder than room noise reached the microphone. */
const [heard, setHeard] = createSignal(false);
/** Only exact zeros so far: the system is withholding the microphone. */
const [deadMic, setDeadMic] = createSignal(false);
const [ready, setReady] = createSignal<Ready>("waiting");
const [readyError, setReadyError] = createSignal("");
const [shortcutFrom, setShortcutFrom] = createSignal(0);

const HEARD_LEVEL = 0.18;
const DEAD_MIC_MS = 3_000;
const englishOnly = (m: VoiceModel) => m.languages === "en";

async function refresh() {
  const list = await (await voiceBackend()).models();
  setModels(list);
}

export default function VoiceSetup() {
  const cleanup: (() => void)[] = [];
  onCleanup(() => cleanup.forEach((f) => f()));
  let heading: HTMLHeadingElement | undefined;

  const current = () => models().find((m) => m.id === chosen());
  const offered = () => models().filter((m) => !englishOnly(m) || lang() === "en" || lang() === "auto");
  const installed = () => !!current()?.installed || (dl().state === "done" && (dl() as { model: string }).model === chosen());
  const downloading = () => dl().state === "running";

  // Opened from Settings: take its place rather than stacking a dialog on a
  // dialog, and hand back to Settings > Voice when done.
  let backToSettings = false;
  createEffect(on(setupOpen, (isOpen) => {
    if (!isOpen) return;
    backToSettings = isSettingsOpen();
    if (backToSettings) closeSettings();
    setStep("language");
    setLang(voiceLanguage() || "auto");
    setChosen(voiceModel() || recommendedFor(voiceLanguage() || "auto"));
    setPicked(!!voiceModel());
    setShowAll(false);
    setDl({ state: "idle" });
    setReady("waiting");
    void refresh();
  }));

  // Screen readers land on each new step's heading.
  createEffect(on(step, () => queueMicrotask(() => heading?.focus()), { defer: true }));

  function close() {
    void stopMicTest();
    if (downloading()) void voiceBackend().then((b) => b.cancelDownload());
    setSetupOpen(false);
    if (backToSettings) { backToSettings = false; openSettings("voice"); }
  }

  /* ---------- step 1: language and model ---------- */

  function chooseLanguage(code: string) {
    setLang(code);
    const fits = offered().some((m) => m.id === chosen());
    if (!picked() || !fits) {
      setChosen(recommendedFor(code));
      setPicked(false);
    }
  }

  async function fromLanguage() {
    const m = current();
    if (!m) return;
    await setVoiceLanguage(lang());
    if (!m.installed) startDownload(m);
    else setDl({ state: "done", model: m.id });
    goMic();
  }

  /** Start (or switch) the background download; resumes a partial one. */
  function startDownload(m: VoiceModel) {
    const d = dl();
    if ((d.state === "running" || d.state === "done") && d.model === m.id) return;
    void (async () => {
      const b = await voiceBackend();
      if (d.state === "running") await b.cancelDownload();
      setReady("waiting");
      setDl({ state: "running", model: m.id, received: m.partial, total: m.size, verifying: false });
      // eslint-disable-next-line solid/reactivity -- an event callback, read when it fires
      const off = await b.onDownload((e) => {
        const now = dl();
        if (e.model !== m.id || now.state !== "running" || now.model !== m.id) return;
        if (e.phase === "download") setDl({ ...now, received: e.received, total: e.total, verifying: false });
        if (e.phase === "verify") setDl({ ...now, received: e.total, total: e.total, verifying: true });
      });
      cleanup.push(off);
      try {
        await b.download(m.id);
        if (dl().state === "running" && (dl() as { model: string }).model === m.id) {
          setDl({ state: "done", model: m.id });
          void refresh();
          if (step() === "try") void prepare();
        }
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        // A cancel (closing, or switching models) is not an error to show.
        if (!/cancel/i.test(msg) && setupOpen() && (dl() as { model?: string }).model === m.id) {
          setDl({ state: "error", model: m.id, message: msg });
        }
      } finally {
        off();
      }
    })();
  }

  function retryDownload() {
    const m = current();
    if (m) { setDl({ state: "idle" }); startDownload(m); }
  }

  /* ---------- step 2: microphone ---------- */

  let offLevel: (() => void) | undefined;
  let deadTimer: number | undefined;

  async function goMic() {
    setStep("mic");
    setMicError("");
    setMic("checking");
    const status = await (await voiceBackend()).permission();
    if (status === "denied" || status === "restricted") setMic("denied");
    // Only macOS asks; elsewhere ("unknown") the check itself tells.
    else if (status === "undetermined") setMic("ask");
    else void startMicTest();
  }

  async function askPermission() {
    setMic("asking");
    const status = await (await voiceBackend()).requestPermission();
    if (status === "denied" || status === "restricted") setMic("denied");
    else void startMicTest();
  }

  async function startMicTest() {
    const b = await voiceBackend();
    setMic("ok");
    setHeard(false);
    setDeadMic(false);
    setMicLevel(0);
    offLevel?.();
    let sawSound = false;
    offLevel = await b.onMicTest((lvl) => {
      setMicLevel(lvl);
      if (lvl > 0) { sawSound = true; setDeadMic(false); }
      if (lvl >= HEARD_LEVEL) setHeard(true);
    });
    clearTimeout(deadTimer);
    deadTimer = window.setTimeout(() => { if (!sawSound && step() === "mic") setDeadMic(true); }, DEAD_MIC_MS);
    try {
      await b.micTestStart(voiceDevice() || null);
    } catch (err) {
      setMic("error");
      setMicError(String((err as Error)?.message ?? err));
    }
  }

  async function stopMicTest() {
    clearTimeout(deadTimer);
    offLevel?.();
    offLevel = undefined;
    setMicLevel(0);
    await (await voiceBackend()).micTestStop();
  }
  cleanup.push(() => void stopMicTest());

  // Picking another microphone re-runs the check on it.
  createEffect(on(voiceDevice, () => { if (setupOpen() && step() === "mic" && mic() === "ok") void startMicTest(); }, { defer: true }));

  function fromMic() {
    void stopMicTest();
    setShortcutFrom(Date.now());
    setStep("shortcut");
  }

  /* ---------- step 4: try it ---------- */

  function goTry() {
    setStep("try");
    if (installed()) void prepare();
  }

  async function prepare() {
    if (ready() === "preparing" || ready() === "ready") return;
    const b = await voiceBackend();
    setReady("preparing");
    // The first load compiles GPU kernels and can take several seconds;
    // later loads are quick. Wait for it here rather than on first use.
    const loaded = new Promise<string | null>((resolve) => {
      void b.onEvent((e) => {
        if (e.kind === "loaded") resolve(null);
        if (e.kind === "error") resolve(e.message);
      }).then((off) => cleanup.push(off));
    });
    try {
      await b.prepare(chosen());
    } catch (err) {
      setReadyError(String((err as Error)?.message ?? err));
      setReady("error");
      return;
    }
    const err = await loaded;
    if (err) {
      setReadyError(err);
      setReady("error");
      return;
    }
    await setVoiceModel(chosen());
    await setVoiceEnabled(true);
    setReady("ready");
  }

  /* ---------- view ---------- */

  const stepIndex = () => STEPS.findIndex((s) => s.id === step());
  const pct = () => {
    const d = dl();
    return d.state === "running" && d.total ? Math.min(100, Math.round((d.received / d.total) * 100)) : d.state === "done" ? 100 : 0;
  };
  const modelLabel = () => current()?.label ?? "the model";

  const DownloadStrip = () => (
    <Show when={dl().state === "running" || dl().state === "error"}>
      <div class="voice-dl" classList={{ error: dl().state === "error" }}>
        <Show
          when={dl().state === "running"}
          fallback={
            <>
              <span class="voice-dl-text" role="alert">The download stopped: {(dl() as { message?: string }).message}</span>
              <button class="ghost-btn" onClick={retryDownload}>Retry</button>
            </>
          }
        >
          {(() => {
            const d = () => dl() as Extract<Download, { state: "running" }>;
            return (
              <>
                <span class="voice-dl-text">
                  {d().verifying ? `Checking ${modelLabel()}…` : `Downloading ${modelLabel()} · ${formatSize(d().received)} of ${formatSize(d().total)}`}
                </span>
                <div class="voice-progress small" role="progressbar" aria-label="Model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct()}>
                  <span style={{ width: `${pct()}%` }} />
                </div>
              </>
            );
          })()}
        </Show>
      </div>
    </Show>
  );

  return (
    <Show when={setupOpen()}>
      <div class="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && !downloading() && close()}>
        <ModalFrame class="voice-setup" label="Set up voice typing" onClose={close}>
          <header class="voice-setup-head">
            <span class="voice-setup-badge" aria-hidden="true"><MicIcon /></span>
            <div>
              <h2>Voice typing</h2>
              <p>Speak and Sarala types it. Speech is turned into text on this computer: nothing is uploaded, and there is no account or key.</p>
            </div>
          </header>

          <ol class="voice-steps" aria-label="Set-up steps">
            <For each={STEPS}>
              {(s, i) => (
                <li classList={{ done: i() < stepIndex(), current: i() === stepIndex() }} aria-current={i() === stepIndex() ? "step" : undefined}>
                  <span class="voice-steps-dot" aria-hidden="true">{i() < stepIndex() ? "✓" : i() + 1}</span>
                  <span class="voice-steps-label">{s.label}</span>
                </li>
              )}
            </For>
          </ol>

          <Show when={voiceSupported() === false}>
            <p class="voice-setup-note" role="alert">
              {platformInfo()?.unsupported ?? "Voice typing isn't available in this build of Sarala."}
            </p>
          </Show>

          <Switch>
            {/* ---- 1. Language ---- */}
            <Match when={step() === "language"}>
              <h3 class="voice-step-title" id="voice-setup-lang" tabIndex={-1} ref={heading}>Which language will you speak?</h3>
              <div class="voice-field">
                {/* Named by the question above it, so what's read and what's seen match (WCAG 2.5.3). */}
                <select class="ip-input ip-select" aria-labelledby="voice-setup-lang" value={lang()} onChange={(e) => chooseLanguage(e.currentTarget.value)}>
                  <For each={LANGUAGES}>{(l) => <option value={l.value}>{l.value === "auto" ? "Several, or detect it" : l.label}</option>}</For>
                </select>
              </div>
              <Show
                when={showAll()}
                fallback={
                  <Show when={current()}>
                    {(m) => (
                      <div class="voice-pick">
                        <div class="voice-model-text">
                          <span class="voice-model-name">
                            {m().label}
                            <Show when={m().id === recommendedFor(lang())}><span class="voice-tag">Recommended</span></Show>
                            <Show when={m().installed}><span class="voice-tag ok">Downloaded</span></Show>
                          </span>
                          <span class="voice-model-blurb">{m().blurb}</span>
                        </div>
                        <span class="voice-model-size">{formatSize(m().size)}</span>
                      </div>
                    )}
                  </Show>
                }
              >
                <fieldset class="voice-models">
                  <legend>Speech models</legend>
                  <For each={offered()}>
                    {(m) => (
                      <label class="voice-model" classList={{ on: chosen() === m.id }}>
                        <input type="radio" name="voice-model" value={m.id} checked={chosen() === m.id} onChange={() => { setChosen(m.id); setPicked(true); }} />
                        <span class="voice-model-text">
                          <span class="voice-model-name">
                            {m.label}
                            <Show when={m.id === recommendedFor(lang())}><span class="voice-tag">Recommended</span></Show>
                            <Show when={m.installed}><span class="voice-tag ok">Downloaded</span></Show>
                          </span>
                          <span class="voice-model-blurb">{m.blurb}</span>
                        </span>
                        <span class="voice-model-size">{formatSize(m.size)}</span>
                      </label>
                    )}
                  </For>
                </fieldset>
              </Show>
              <button class="voice-more" aria-expanded={showAll()} onClick={() => setShowAll(!showAll())}>
                {showAll() ? "Show only the recommended model" : "Other models"}
              </button>
              <p class="voice-step-sub">
                {current()?.installed
                  ? "Already downloaded."
                  : `It downloads once (${current() ? formatSize(current()!.size - current()!.partial) : "…"}) while you set up the rest, then works offline.`}
              </p>
              <div class="voice-setup-actions">
                <button class="pandoc-btn ghost" onClick={close}>Not now</button>
                <button class="pandoc-btn primary" disabled={!current() || voiceSupported() === false} onClick={() => void fromLanguage()}>Continue</button>
              </div>
              <p class="voice-setup-foot">
                Models by NVIDIA, OpenAI and Useful Sensors, converted by the Handy project, downloaded from Hugging Face.
              </p>
            </Match>

            {/* ---- 2. Microphone ---- */}
            <Match when={step() === "mic"}>
              <Switch>
                <Match when={mic() === "checking"}>
                  <h3 class="voice-step-title" tabIndex={-1} ref={heading}>Checking the microphone…</h3>
                </Match>
                <Match when={mic() === "ask" || mic() === "asking"}>
                  <h3 class="voice-step-title" tabIndex={-1} ref={heading}>Sarala needs to hear you</h3>
                  <p class="voice-step-sub">
                    Your computer asks once whether Sarala may use the microphone. Sarala only listens while you dictate,
                    and what you say never leaves this computer.
                  </p>
                  <div class="voice-setup-actions">
                    <button class="pandoc-btn ghost" onClick={() => setStep("language")}>Back</button>
                    <button class="pandoc-btn primary" disabled={mic() !== "ask"} onClick={() => void askPermission()}>
                      {mic() === "asking" ? "Waiting for your answer…" : "Continue"}
                    </button>
                  </div>
                </Match>
                <Match when={mic() === "denied"}>
                  <h3 class="voice-step-title" tabIndex={-1} ref={heading}>Microphone access is off</h3>
                  <p class="voice-step-sub">
                    {platformInfo()?.os === "windows"
                      ? "In Windows Settings > Privacy & security > Microphone, turn on “Microphone access” and “Let desktop apps access your microphone”, then try again."
                      : "In System Settings > Privacy & Security > Microphone, turn on Sarala, then try again."}
                  </p>
                  <div class="voice-setup-actions">
                    <Show when={privacySettingsAction()}>
                      {(a) => <button class="pandoc-btn ghost" onClick={a().run}>{a().label}</button>}
                    </Show>
                    <button class="pandoc-btn primary" onClick={() => void goMic()}>Try again</button>
                  </div>
                </Match>
                <Match when={mic() === "ok" || mic() === "error"}>
                  <h3 class="voice-step-title" tabIndex={-1} ref={heading}>Check your microphone</h3>
                  <div class="voice-field">
                    <VoiceDeviceRow />
                  </div>
                  <div class="voice-meter" aria-hidden="true">
                    <span style={{ transform: `scaleX(${Math.min(1, micLevel() * 1.4)})` }} />
                  </div>
                  <p class="voice-mic-status" role="status">
                    <Switch fallback={<>Say something: the bar should move.</>}>
                      <Match when={mic() === "error"}>{micError()}</Match>
                      <Match when={heard()}><span class="voice-check-ok">✓ Sarala can hear you.</span></Match>
                      <Match when={deadMic()}>
                        No sound from this microphone. Check it isn't muted, or pick another.
                        <Show when={platformInfo()?.sandbox === "snap"}> In the Snap version, run <code>snap connect sarala:audio-record</code> first.</Show>
                      </Match>
                    </Switch>
                  </p>
                  <div class="voice-setup-actions">
                    <button class="pandoc-btn ghost" onClick={() => { void stopMicTest(); setStep("language"); }}>Back</button>
                    <button class="pandoc-btn primary" onClick={fromMic}>Continue</button>
                  </div>
                </Match>
              </Switch>
              <DownloadStrip />
            </Match>

            {/* ---- 3. Shortcut ---- */}
            <Match when={step() === "shortcut"}>
              <h3 class="voice-step-title" tabIndex={-1} ref={heading}>Pick a shortcut</h3>
              <p class="voice-step-sub">Any key you can reach comfortably. Press it to check it reaches Sarala.</p>
              <div class="voice-options">
                <div class="set-row">
                  <div class="set-row-text">
                    <span class="set-row-label" id="voice-setup-shortcut">Shortcut</span>
                  </div>
                  <div class="set-row-ctl" role="group" aria-labelledby="voice-setup-shortcut">
                    <VoiceShortcutRow />
                  </div>
                </div>
              </div>
              <div class="voice-check" role="status">
                <Show
                  when={shortcutSeenAt() > shortcutFrom()}
                  fallback={<>Press <kbd>{shortcutLabel(voiceShortcut())}</kbd> now. If nothing happens, another app is using it: pick another.</>}
                >
                  <span class="voice-check-ok">✓ The shortcut works.</span>
                </Show>
              </div>
              <div class="voice-options">
                <div class="voice-trigger-block">
                  <span class="set-row-label">Shortcut behaviour</span>
                  <VoiceTriggerRow />
                </div>
                <div class="set-row">
                  <div class="set-row-text">
                    <span class="set-row-label">When you pause</span>
                    <span class="set-row-desc">“Type, keep going” lets you dictate hands-free.</span>
                  </div>
                  <div class="set-row-ctl">
                    <select class="ip-input ip-select" aria-label="When you pause" value={voicePause()} onChange={(e) => void setVoicePause(e.currentTarget.value as PauseMode)}>
                      <For each={PAUSE_OPTIONS}>{(o) => <option value={o.value}>{o.label}</option>}</For>
                    </select>
                  </div>
                </div>
                <div class="set-row">
                  <div class="set-row-text">
                    <span class="set-row-label">Command key</span>
                    <span class="set-row-desc">Tap it alone to start or stop; hold it to say a command.</span>
                  </div>
                  <div class="set-row-ctl">
                    <select class="ip-input ip-select" aria-label="Command key" value={voiceCommandKey()} onChange={(e) => void setVoiceCommandKey(e.currentTarget.value)}>
                      <For each={COMMAND_KEYS}>{(k) => <option value={k.id}>{k.label}</option>}</For>
                    </select>
                  </div>
                </div>
              </div>
              <div class="voice-setup-actions">
                <button class="pandoc-btn ghost" onClick={() => void goMic()}>Back</button>
                <button class="pandoc-btn primary" onClick={goTry}>Continue</button>
              </div>
              <DownloadStrip />
            </Match>

            {/* ---- 4. Try it ---- */}
            <Match when={step() === "try"}>
              <Switch>
                <Match when={dl().state === "error"}>
                  <h3 class="voice-step-title" tabIndex={-1} ref={heading}>The download didn't finish</h3>
                  <p class="voice-step-sub" role="alert">{(dl() as { message?: string }).message}</p>
                  <p class="voice-step-sub">It picks up where it stopped.</p>
                  <div class="voice-setup-actions">
                    <button class="pandoc-btn ghost" onClick={close}>Close</button>
                    <button class="pandoc-btn primary" onClick={retryDownload}>Retry</button>
                  </div>
                </Match>
                <Match when={ready() === "error"}>
                  <h3 class="voice-step-title" tabIndex={-1} ref={heading}>That didn't work</h3>
                  <p class="voice-step-sub" role="alert">{readyError()}</p>
                  <div class="voice-setup-actions">
                    <button class="pandoc-btn ghost" onClick={close}>Close</button>
                    <button class="pandoc-btn primary" onClick={() => { setReady("waiting"); void prepare(); }}>Try again</button>
                  </div>
                </Match>
                <Match when={ready() !== "ready"}>
                  <div class="voice-progress-wrap">
                    <h3 class="voice-step-title" tabIndex={-1} ref={heading}>
                      {downloading() ? `Finishing the download of ${modelLabel()}…` : "Getting the model ready…"}
                    </h3>
                    <Show
                      when={downloading()}
                      fallback={<div class="voice-progress indeterminate" role="progressbar" aria-label="Preparing the model"><span /></div>}
                    >
                      <div class="voice-progress" role="progressbar" aria-label="Model download" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct()}>
                        <span style={{ width: `${pct()}%` }} />
                      </div>
                    </Show>
                    <p class="voice-step-sub">
                      {downloading()
                        ? `${formatSize((dl() as { received: number }).received)} of ${formatSize((dl() as { total: number }).total)}. If you close this, it picks up where it left off next time.`
                        : "The first time takes a few seconds."}
                    </p>
                    <div class="voice-setup-actions">
                      <button class="pandoc-btn ghost" onClick={() => setStep("shortcut")}>Back</button>
                    </div>
                  </div>
                </Match>
                <Match when={ready() === "ready"}>
                  <h3 class="voice-step-title" tabIndex={-1} ref={heading}>Voice typing is on</h3>
                  <div class="voice-try">
                    <textarea class="ip-input" rows={3} aria-label="Try voice typing here" placeholder="Click here, then use the shortcut and say something." />
                    <VoiceButton class="voice-try-btn" />
                  </div>
                  <ul class="voice-tips">
                    <li><kbd>{shortcutLabel(voiceShortcut())}</kbd> starts and stops, anywhere you can type. So does the mic button, top right.</li>
                    <li>Say “new paragraph”, “scratch that”, or “what can I say” for every command.</li>
                    <Show when={voiceCommandKey() !== "off"}>
                      <li>Hold <kbd>{commandKeyLabel(voiceCommandKey())}</kbd> to say a command instead of typing it.</li>
                    </Show>
                  </ul>
                  <Show when={platformInfo()?.sandbox === "snap"}>
                    <p class="voice-setup-note">
                      This is the Snap version: allow the microphone once by running <code>snap connect sarala:audio-record</code> in a terminal.
                    </p>
                  </Show>
                  <div class="voice-setup-actions">
                    <button class="pandoc-btn ghost" onClick={() => { backToSettings = true; close(); }}>More options</button>
                    <button class="pandoc-btn primary" onClick={close}>Done</button>
                  </div>
                </Match>
              </Switch>
            </Match>
          </Switch>
        </ModalFrame>
      </div>
    </Show>
  );
}
