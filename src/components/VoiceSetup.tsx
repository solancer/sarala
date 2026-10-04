/**
 * Voice typing set-up: choose a model, download it, allow the microphone,
 * and try it. This is the opt-in: nothing is downloaded or listened to
 * before the user goes through it.
 */
import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup } from "solid-js";
import ModalFrame from "./ModalFrame";
import { MicIcon, VoiceButton } from "./VoiceHud";
import {
  PAUSE_OPTIONS, commandKeyLabel, recommendedModel, voiceCommandKey, setVoiceEnabled, setVoiceModel, setVoicePause, shortcutLabel, voiceModel, voicePause,
  voiceShortcut, type PauseMode,
} from "../voice/config";
import {
  platformInfo, privacySettingsAction, setSetupOpen, setupOpen, shortcutSeenAt, voiceSupported,
} from "../voice/session";
import { VoiceShortcutRow } from "./VoiceSettings";
import { openSettings } from "./SettingsModal";
import { formatSize, voiceBackend, type VoiceModel } from "../voice/transport";

type Step =
  | { kind: "choose" }
  | { kind: "download"; received: number; total: number; verifying: boolean }
  | { kind: "mic" }
  | { kind: "mic-denied" }
  | { kind: "prepare" }
  | { kind: "ready" }
  | { kind: "error"; message: string };

const [step, setStep] = createSignal<Step>({ kind: "choose" });
const [models, setModels] = createSignal<VoiceModel[]>([]);
const [chosen, setChosen] = createSignal("");
const [readyAt, setReadyAt] = createSignal(0);

async function refresh() {
  const list = await (await voiceBackend()).models();
  setModels(list);
  if (!chosen()) setChosen(voiceModel() || recommendedModel());
}

export default function VoiceSetup() {
  const cleanup: (() => void)[] = [];
  onCleanup(() => cleanup.forEach((f) => f()));

  createEffect(on(setupOpen, (isOpen) => {
    if (!isOpen) return;
    setStep({ kind: "choose" });
    setChosen("");
    void refresh();
  }));
  const close = () => {
    if (step().kind === "download") void voiceBackend().then((b) => b.cancelDownload());
    setSetupOpen(false);
  };

  const current = () => models().find((m) => m.id === chosen());

  async function begin() {
    const m = current();
    if (!m) return;
    const b = await voiceBackend();
    if (!m.installed) {
      setStep({ kind: "download", received: m.partial, total: m.size, verifying: false });
      // eslint-disable-next-line solid/reactivity -- an event callback, read when it fires
      const off = await b.onDownload((e) => {
        if (e.model !== m.id || step().kind !== "download") return;
        if (e.phase === "download") setStep({ kind: "download", received: e.received, total: e.total, verifying: false });
        if (e.phase === "verify") setStep({ kind: "download", received: e.total, total: e.total, verifying: true });
      });
      cleanup.push(off);
      try {
        await b.download(m.id);
      } catch (err) {
        off();
        const msg = String((err as Error)?.message ?? err);
        // Cancelling closes the dialog; anything else is worth explaining.
        if (!/cancel/i.test(msg) && setupOpen()) setStep({ kind: "error", message: msg });
        return;
      }
      off();
      if (!setupOpen()) return;
    }
    await setVoiceModel(m.id);
    await allowMic();
  }

  async function allowMic() {
    const b = await voiceBackend();
    setStep({ kind: "mic" });
    const status = await b.requestPermission();
    if (status === "denied" || status === "restricted") {
      setStep({ kind: "mic-denied" });
      return;
    }
    await prepare();
  }

  async function prepare() {
    const b = await voiceBackend();
    setStep({ kind: "prepare" });
    // The first load compiles GPU kernels and can take several seconds;
    // later loads are quick. Wait for it here rather than on first use.
    const loaded = new Promise<string | null>((resolve) => {
      void b.onEvent((e) => {
        if (e.kind === "loaded") resolve(null);
        if (e.kind === "error") resolve(e.message);
      }).then((off) => cleanup.push(off));
    });
    try {
      await b.prepare(voiceModel());
    } catch (err) {
      setStep({ kind: "error", message: String((err as Error)?.message ?? err) });
      return;
    }
    const err = await loaded;
    if (err) {
      setStep({ kind: "error", message: err });
      return;
    }
    await setVoiceEnabled(true);
    setReadyAt(Date.now());
    setStep({ kind: "ready" });
  }

  return (
    <Show when={setupOpen()}>
          <div class="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && step().kind !== "download" && close()}>
            <ModalFrame class="voice-setup" label="Set up voice typing" onClose={close}>
              <header class="voice-setup-head">
                <span class="voice-setup-badge" aria-hidden="true"><MicIcon /></span>
                <div>
                  <h2>Voice typing</h2>
                  <p>Speak and Sarala types it. Speech is turned into text on this computer: nothing is uploaded, and there is no account or key.</p>
                </div>
              </header>

              <Show when={voiceSupported() === false}>
                <p class="voice-setup-note" role="alert">
                  {platformInfo()?.unsupported ?? "Voice typing isn't available in this build of Sarala."}
                </p>
              </Show>

              <Switch>
                <Match when={step().kind === "choose"}>
                  <fieldset class="voice-models">
                    <legend>Choose a speech model. It is downloaded once.</legend>
                    <For each={models()}>
                      {(m) => (
                        <label class="voice-model" classList={{ on: chosen() === m.id }}>
                          <input type="radio" name="voice-model" value={m.id} checked={chosen() === m.id} onChange={() => setChosen(m.id)} />
                          <span class="voice-model-text">
                            <span class="voice-model-name">
                              {m.label}
                              <Show when={m.id === recommendedModel()}><span class="voice-tag">Recommended</span></Show>
                              <Show when={m.installed}><span class="voice-tag ok">Downloaded</span></Show>
                            </span>
                            <span class="voice-model-blurb">{m.blurb}</span>
                          </span>
                          <span class="voice-model-size">{formatSize(m.size)}</span>
                        </label>
                      )}
                    </For>
                  </fieldset>
                  <div class="voice-setup-actions">
                    <button class="pandoc-btn ghost" onClick={close}>Not now</button>
                    <button class="pandoc-btn primary" disabled={!current() || voiceSupported() === false} onClick={() => void begin()}>
                      {current()?.installed ? "Turn on" : current() ? `Download ${formatSize(current()!.size - current()!.partial)}` : "Download"}
                    </button>
                  </div>
                </Match>

                <Match when={step().kind === "download"}>
                  {(() => {
                    const s = () => step() as Extract<Step, { kind: "download" }>;
                    const pct = () => (s().total ? Math.min(100, Math.round((s().received / s().total) * 100)) : 0);
                    return (
                      <div class="voice-progress-wrap">
                        <p class="voice-step-title">
                          {s().verifying ? "Checking the download…" : `Downloading ${current()?.label ?? "the model"}…`}
                        </p>
                        <div class="voice-progress" role="progressbar" aria-label="Download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct()}>
                          <span style={{ width: `${pct()}%` }} />
                        </div>
                        <p class="voice-step-sub">
                          {formatSize(s().received)} of {formatSize(s().total)}. If you stop, it picks up where it left off next time.
                        </p>
                        <div class="voice-setup-actions">
                          <button class="pandoc-btn ghost" onClick={close}>Cancel</button>
                        </div>
                      </div>
                    );
                  })()}
                </Match>

                <Match when={step().kind === "mic"}>
                  <p class="voice-step-title">Allow the microphone</p>
                  <p class="voice-step-sub">Your computer asks once whether Sarala may use the microphone.</p>
                </Match>

                <Match when={step().kind === "mic-denied"}>
                  <p class="voice-step-title">Microphone access is off</p>
                  <p class="voice-step-sub">
                    {platformInfo()?.os === "windows"
                      ? "In Windows Settings > Privacy & security > Microphone, turn on “Microphone access” and “Let desktop apps access your microphone”, then try again."
                      : "In System Settings > Privacy & Security > Microphone, turn on Sarala, then try again."}
                  </p>
                  <div class="voice-setup-actions">
                    <Show when={privacySettingsAction()}>
                      {(a) => <button class="pandoc-btn ghost" onClick={a().run}>{a().label}</button>}
                    </Show>
                    <button class="pandoc-btn primary" onClick={() => void allowMic()}>Try again</button>
                  </div>
                </Match>

                <Match when={step().kind === "prepare"}>
                  <div class="voice-progress-wrap">
                    <p class="voice-step-title">Getting the model ready…</p>
                    <div class="voice-progress indeterminate" role="progressbar" aria-label="Preparing the model"><span /></div>
                    <p class="voice-step-sub">The first time takes a few seconds.</p>
                  </div>
                </Match>

                <Match when={step().kind === "ready"}>
                  <p class="voice-step-title">Voice typing is on</p>
                  <p class="voice-step-sub">
                    Hold <kbd>{shortcutLabel(voiceShortcut())}</kbd> and speak, then let go; or press it once to start and
                    again to finish. The mic button beside Focus mode (top right) and Edit &gt; Voice Typing do the same. Say “new
                    paragraph” to start one, “scratch that” to remove what you just said, or “what can I say” for every command.<Show when={voiceCommandKey() !== "off"}> Tap {commandKeyLabel(voiceCommandKey())} on its own to start or stop; hold it to say a command.</Show>
                  </p>
                  <Show when={platformInfo()?.sandbox === "snap"}>
                    <p class="voice-setup-note">
                      This is the Snap version: allow the microphone once by running <code>snap connect sarala:audio-record</code> in a terminal.
                    </p>
                  </Show>
                  <div class="voice-try">
                    <textarea class="ip-input" rows={3} aria-label="Try voice typing here" placeholder="Click here, then use the shortcut and say something." />
                    <VoiceButton class="voice-try-btn" />
                  </div>
                  <div class="voice-check" role="status">
                    <Show
                      when={shortcutSeenAt() > readyAt()}
                      fallback={<>Press <kbd>{shortcutLabel(voiceShortcut())}</kbd> to check it reaches Sarala. If nothing happens, another app is using it: pick another below.</>}
                    >
                      <span class="voice-check-ok">✓ The shortcut works.</span>
                    </Show>
                  </div>
                  <div class="voice-options">
                    <div class="set-row">
                      <div class="set-row-text">
                        <span class="set-row-label" id="voice-setup-shortcut">Shortcut</span>
                        <span class="set-row-desc">Any key you can reach comfortably.</span>
                      </div>
                      <div class="set-row-ctl" role="group" aria-labelledby="voice-setup-shortcut">
                        <VoiceShortcutRow />
                      </div>
                    </div>
                    <div class="set-row">
                      <div class="set-row-text">
                        <span class="set-row-label">When you pause</span>
                        <span class="set-row-desc">Type as you go to dictate hands-free.</span>
                      </div>
                      <div class="set-row-ctl">
                        <select class="ip-input ip-select" aria-label="When you pause" value={voicePause()} onChange={(e) => void setVoicePause(e.currentTarget.value as PauseMode)}>
                          <For each={PAUSE_OPTIONS}>{(o) => <option value={o.value}>{o.label}</option>}</For>
                        </select>
                      </div>
                    </div>
                  </div>
                  <div class="voice-setup-actions">
                    <button class="pandoc-btn ghost" onClick={() => { close(); openSettings("voice"); }}>More options</button>
                    <button class="pandoc-btn primary" onClick={close}>Done</button>
                  </div>
                </Match>

                <Match when={step().kind === "error"}>
                  <p class="voice-step-title">That didn't work</p>
                  <p class="voice-step-sub" role="alert">{(step() as Extract<Step, { kind: "error" }>).message}</p>
                  <div class="voice-setup-actions">
                    <button class="pandoc-btn ghost" onClick={close}>Close</button>
                    <button class="pandoc-btn primary" onClick={() => { setStep({ kind: "choose" }); void refresh(); }}>Try again</button>
                  </div>
                </Match>
              </Switch>

              <Show when={step().kind === "choose"}>
                <p class="voice-setup-foot">
                  Models by NVIDIA, OpenAI and Useful Sensors, converted by the Handy project, downloaded from Hugging Face.
                </p>
              </Show>
            </ModalFrame>
          </div>
    </Show>
  );
}
