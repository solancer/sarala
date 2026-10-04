/**
 * The parts of Settings > Voice that need live data: the chosen model, the
 * microphone list and the downloaded models.
 */
import { For, Show, createEffect, createResource, createSignal, on, onCleanup, onMount } from "solid-js";
import {
  SHORTCUTS, setVoiceDevice, setVoiceModel, setVoiceShortcut, shortcutLabel, voiceDevice, voiceModel, voiceShortcut,
} from "../voice/config";
import { accelToShortcut, shortcutFromEvent } from "../voice/text";
import { MENUS, type MenuNode } from "../menudata";
import { isMac } from "../platform";
import { openVoiceSetup, setRecordingShortcut, setupOpen, voiceSupported } from "../voice/session";
import { formatSize, voiceBackend, type VoiceModel } from "../voice/transport";

const [models, setModels] = createSignal<VoiceModel[]>([]);
const refetchModels = async () => setModels(await (await voiceBackend()).models());

/** Load the list when a row appears, and again after the set-up closes
 *  (it may have downloaded a model). */
function useModels() {
  onMount(() => void refetchModels());
  createEffect(on(setupOpen, (open, was) => { if (was && !open) void refetchModels(); }, { defer: true }));
}

export function VoiceModelRow() {
  useModels();
  const label = () => models().find((m) => m.id === voiceModel())?.label;
  return (
    <div class="voice-model-row">
      <span>{label() ?? "None yet"}</span>
      <button class="ghost-btn" disabled={voiceSupported() === false} onClick={openVoiceSetup}>
        {voiceModel() ? "Change…" : "Set up…"}
      </button>
    </div>
  );
}

export function VoiceDeviceRow() {
  const [devices] = createResource(async () => (await voiceBackend()).devices().catch(() => [] as string[]));
  return (
    <select
      class="ip-input ip-select"
      aria-label="Microphone"
      value={voiceDevice()}
      onChange={(e) => void setVoiceDevice(e.currentTarget.value)}
    >
      <option value="">System default</option>
      <For each={devices() ?? []}>{(d) => <option value={d}>{d}</option>}</For>
      {/* Keep a chosen device that is unplugged right now. */}
      <Show when={voiceDevice() && !(devices() ?? []).includes(voiceDevice())}>
        <option value={voiceDevice()}>{voiceDevice()} (not connected)</option>
      </Show>
    </select>
  );
}

export function VoiceInstalledRow() {
  useModels();
  const installed = () => models().filter((m) => m.installed);
  const remove = async (id: string) => {
    await (await voiceBackend()).deleteModel(id);
    if (id === voiceModel()) await setVoiceModel("");
    await refetchModels();
  };
  return (
    <div class="voice-installed">
      <Show when={installed().length} fallback={<span class="set-row-desc">None</span>}>
        <For each={installed()}>
          {(m) => (
            <div class="voice-installed-row">
              <span>{m.label} · {formatSize(m.size)}</span>
              <button class="ghost-btn" aria-label={`Remove ${m.label}`} onClick={() => void remove(m.id)}>Remove</button>
            </div>
          )}
        </For>
      </Show>
    </div>
  );
}

/* ---------- shortcut ---------- */

/** Shortcuts Sarala itself uses, from the menus, as shortcut ids → label. */
export function appShortcuts(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (nodes: MenuNode[], path: string) => {
    for (const n of nodes) {
      if ("sep" in n || "dynamic" in n) continue;
      if (n.accel && !n.exec) out.set(accelToShortcut(n.accel, isMac), `${path}${n.label}`);
      if (n.items) walk(n.items, `${path}${n.label} > `);
    }
  };
  for (const m of MENUS) walk(m.items, `${m.label} > `);
  // Bound outside the menus.
  out.set(isMac ? "Meta+K" : "Ctrl+K", "Command palette");
  out.set("Shift+F10", "Context menu");
  out.set(isMac ? "Meta+Enter" : "Ctrl+Enter", "Open link");
  return out;
}

export function VoiceShortcutRow() {
  const [recording, setRecording] = createSignal(false);
  const [error, setError] = createSignal("");
  let btn!: HTMLButtonElement;
  const preset = () => SHORTCUTS.find((s) => s.id === voiceShortcut());

  const stopRecording = () => {
    setRecording(false);
    setRecordingShortcut(false);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!recording()) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "Escape") {
      stopRecording();
      setError("");
      return;
    }
    const r = shortcutFromEvent(e);
    if (!r) return; // modifiers only, so far
    if ("error" in r) {
      setError(r.error);
      return;
    }
    const clash = appShortcuts().get(r.id);
    if (clash) {
      setError(`${shortcutLabel(r.id)} is already used for ${clash}. Try another.`);
      return;
    }
    stopRecording();
    setError("");
    void setVoiceShortcut(r.id);
  };
  onCleanup(stopRecording);

  return (
    <div class="voice-shortcut">
      <div class="voice-shortcut-row">
        <select
          class="ip-input ip-select"
          aria-label="Voice typing shortcut"
          value={preset() ? voiceShortcut() : "custom"}
          onChange={(e) => { if (e.currentTarget.value !== "custom") void setVoiceShortcut(e.currentTarget.value); }}
        >
          <For each={SHORTCUTS}>{(s) => <option value={s.id}>{shortcutLabel(s.id)}</option>}</For>
          <Show when={!preset()}><option value="custom">{shortcutLabel(voiceShortcut())}</option></Show>
        </select>
        <button
          ref={btn}
          class="ghost-btn"
          aria-pressed={recording()}
          onClick={() => {
            setError("");
            setRecording(!recording());
            setRecordingShortcut(recording());
          }}
          onKeyDown={onKey}
          onBlur={stopRecording}
        >
          {recording() ? "Press keys…" : "Record…"}
        </button>
      </div>
      <span class="voice-shortcut-msg" role="status">
        {error() || (recording() ? "Press the new shortcut. Esc cancels." : preset()?.note ?? "")}
      </span>
    </div>
  );
}
