/**
 * Calls into the Rust voice pipeline (src-tauri/src/voice/). In the browser
 * dev build a scripted mock stands in (src/voice/mock.ts), so the UI and the
 * e2e tests run without a microphone or a model; production browser builds
 * have no voice typing at all.
 */
import { isTauri } from "../platform";

export interface VoiceModel {
  id: string;
  label: string;
  blurb: string;
  /** "en" or "multi". */
  languages: string;
  streaming: boolean;
  size: number;
  license: string;
  installed: boolean;
  /** Bytes of an unfinished download. */
  partial: number;
}

export type VoiceEvent =
  | { kind: "phase"; phase: "loading" | "listening" | "transcribing" }
  | { kind: "level"; level: number }
  | { kind: "text"; committed: string; tentative: string }
  | { kind: "speech"; speaking: boolean }
  | { kind: "loaded"; model: string; ms: number; backend: string }
  | { kind: "unloaded" }
  | { kind: "error"; message: string };

export interface DownloadEvent {
  model: string;
  phase: "download" | "verify" | "done" | "cancelled" | "error";
  received: number;
  total: number;
  message: string | null;
}

/** "granted" | "denied" | "restricted" | "undetermined" | "unknown" */
export type Permission = string;

export interface PlatformInfo {
  os: "macos" | "windows" | "linux" | string;
  /** Snap and Flatpak decide microphone access themselves. */
  sandbox: "snap" | "flatpak" | null;
  /** Why voice typing can't run here (old processor, left out of the build). */
  unsupported: string | null;
}

export interface Backend {
  supported(): Promise<boolean>;
  platform(): Promise<PlatformInfo>;
  models(): Promise<VoiceModel[]>;
  download(model: string): Promise<void>;
  cancelDownload(): Promise<void>;
  deleteModel(model: string): Promise<void>;
  permission(): Promise<Permission>;
  requestPermission(): Promise<Permission>;
  devices(): Promise<string[]>;
  prepare(model: string): Promise<void>;
  start(model: string, device: string | null, language: string | null): Promise<void>;
  stop(): Promise<string>;
  /** Type what was said so far and keep listening. */
  commit(): Promise<string>;
  cancel(): Promise<void>;
  unload(): Promise<void>;
  setIdle(minutes: number | null): Promise<void>;
  onEvent(cb: (e: VoiceEvent) => void): Promise<() => void>;
  onDownload(cb: (e: DownloadEvent) => void): Promise<() => void>;
}

const DEV = import.meta.env?.DEV ?? false;

function tauriBackend(): Backend {
  const call = async <T>(cmd: string, args?: Record<string, unknown>) =>
    (await import("@tauri-apps/api/core")).invoke<T>(cmd, args);
  const listen = async <T>(event: string, cb: (p: T) => void) =>
    (await import("@tauri-apps/api/event")).listen<T>(event, (e) => cb(e.payload));
  return {
    supported: () => call("voice_supported"),
    platform: () => call("voice_platform"),
    models: () => call("voice_models"),
    download: (model) => call("voice_download", { model }),
    cancelDownload: () => call("voice_cancel_download"),
    deleteModel: (model) => call("voice_delete_model", { model }),
    permission: () => call("voice_permission"),
    requestPermission: () => call("voice_request_permission"),
    devices: () => call("voice_devices"),
    prepare: (model) => call("voice_prepare", { model }),
    start: (model, device, language) => call("voice_start", { model, device, language }),
    stop: () => call("voice_stop"),
    commit: () => call("voice_commit"),
    cancel: () => call("voice_cancel"),
    unload: () => call("voice_unload"),
    setIdle: (minutes) => call("voice_set_idle", { minutes: minutes !== null && minutes < 0 ? null : minutes }),
    onEvent: (cb) => listen("voice", cb),
    onDownload: (cb) => listen("voice-download", cb),
  };
}

const unsupported: Backend = {
  supported: async () => false,
  platform: async () => ({ os: "unknown", sandbox: null, unsupported: "Voice typing needs the desktop app." }),
  models: async () => [],
  download: async () => { throw new Error("Voice typing needs the desktop app."); },
  cancelDownload: async () => {},
  deleteModel: async () => {},
  permission: async () => "unknown",
  requestPermission: async () => "unknown",
  devices: async () => [],
  prepare: async () => {},
  start: async () => { throw new Error("Voice typing needs the desktop app."); },
  stop: async () => "",
  commit: async () => "",
  cancel: async () => {},
  unload: async () => {},
  setIdle: async () => {},
  onEvent: async () => () => {},
  onDownload: async () => () => {},
};

let backend: Promise<Backend> | null = null;
export function voiceBackend(): Promise<Backend> {
  backend ??= isTauri
    ? Promise.resolve(tauriBackend())
    : DEV
      ? import("./mock").then((m) => m.mockBackend())
      : Promise.resolve(unsupported);
  return backend;
}

export function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}
