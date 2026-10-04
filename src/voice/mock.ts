/**
 * Dev-only stand-in for the Rust voice pipeline, so `pnpm dev` and the e2e
 * tests can exercise the whole UI without a microphone or a model. It "hears"
 * a scripted sentence a word at a time, like a streaming model.
 *
 * Test hooks on `window`:
 *   __saralaVoiceScript   the text to "hear" (default below); " | " marks a pause
 *   __saralaVoicePauseTicks  how long a pause lasts, in word ticks (default 12)
 *   __saralaVoiceDeadMic  the microphone delivers digital silence (level 0)
 *   __saralaVoiceSandbox / __saralaVoiceUnsupported  what platform() reports
 *   __saralaVoicePermission  the permission to report ("granted" default)
 *   __saralaVoiceSilent   hear nothing (stop returns "")
 *   __saralaVoiceDelay    ms per word (default 120)
 *   __saralaVoiceOpenDelay   ms the microphone takes to open (default 0)
 *   __saralaVoiceMicOpen  (read) whether the mock microphone is running
 */
import type { Backend, DownloadEvent, VoiceEvent, VoiceModel } from "./transport";

const MODELS: Omit<VoiceModel, "installed" | "partial">[] = [
  { id: "parakeet-en", label: "Parakeet (English)", blurb: "Fast and accurate. Shows words as you speak.", languages: "en", streaming: true, size: 477_274_496, license: "CC-BY-4.0 (NVIDIA)" },
  { id: "whisper-small", label: "Whisper Small", blurb: "Around 99 languages. Text appears when you stop.", languages: "multi", streaming: false, size: 171_630_656, license: "Apache-2.0 (OpenAI)" },
  { id: "moonshine-base", label: "Moonshine Base (English)", blurb: "Small and quick, for older computers.", languages: "en", streaming: false, size: 77_476_480, license: "MIT (Useful Sensors)" },
  { id: "whisper-turbo", label: "Whisper Large v3 Turbo", blurb: "Most accurate, about 100 languages. Slower and larger.", languages: "multi", streaming: false, size: 536_069_728, license: "Apache-2.0 (OpenAI)" },
];

type W = Window & {
  __saralaVoiceScript?: string;
  __saralaVoicePermission?: string;
  __saralaVoiceSilent?: boolean;
  __saralaVoiceDelay?: number;
  __saralaVoiceOpenDelay?: number;
  __saralaVoiceMicOpen?: boolean;
  __saralaVoicePauseTicks?: number;
  __saralaVoiceDeadMic?: boolean;
  __saralaVoiceSandbox?: "snap" | "flatpak";
  __saralaVoiceUnsupported?: string;
};

const DEFAULT_SCRIPT = "The quick brown fox jumps over the lazy dog.";
const w = window as W;

export function mockBackend(): Backend {
  const installed = new Set<string>(JSON.parse(localStorage.getItem("sarala.voiceMockInstalled") ?? "[]"));
  const save = () => localStorage.setItem("sarala.voiceMockInstalled", JSON.stringify([...installed]));
  const events = new Set<(e: VoiceEvent) => void>();
  const downloads = new Set<(e: DownloadEvent) => void>();
  const emit = (e: VoiceEvent) => events.forEach((cb) => cb(e));
  let loaded = "";
  let timer: number | undefined;
  let heard: string[] = [];
  /** The script's words, with "|" for pauses. */
  let script: string[] = [];
  /** Words already handed out by commit(). */
  let committed = 0;
  const words = () => script.filter((x) => x !== "|");
  let downloading: { cancel(): void } | null = null;

  const stopTimer = () => { clearInterval(timer); timer = undefined; w.__saralaVoiceMicOpen = false; };

  return {
    supported: async () => !w.__saralaVoiceUnsupported,
    platform: async () => ({
      os: /Mac/.test(navigator.userAgent) ? "macos" : /Windows/.test(navigator.userAgent) ? "windows" : "linux",
      sandbox: w.__saralaVoiceSandbox ?? null,
      unsupported: w.__saralaVoiceUnsupported ?? null,
    }),
    models: async () => MODELS.map((m) => ({ ...m, installed: installed.has(m.id), partial: 0 })),
    download: (model) =>
      new Promise<void>((resolve, reject) => {
        const m = MODELS.find((x) => x.id === model)!;
        let got = 0;
        const send = (e: Omit<DownloadEvent, "model" | "total">) => downloads.forEach((cb) => cb({ model, total: m.size, ...e }));
        const t = window.setInterval(() => {
          got = Math.min(m.size, got + m.size / 8);
          send({ phase: "download", received: got, message: null });
          if (got >= m.size) {
            clearInterval(t);
            send({ phase: "verify", received: got, message: null });
            setTimeout(() => {
              installed.add(model);
              save();
              downloading = null;
              send({ phase: "done", received: got, message: null });
              resolve();
            }, 100);
          }
        }, 60);
        downloading = {
          cancel: () => {
            clearInterval(t);
            downloading = null;
            send({ phase: "cancelled", received: 0, message: null });
            reject(new Error("cancelled"));
          },
        };
      }),
    cancelDownload: async () => downloading?.cancel(),
    deleteModel: async (model) => { installed.delete(model); save(); if (loaded === model) loaded = ""; },
    permission: async () => w.__saralaVoicePermission ?? "granted",
    requestPermission: async () => w.__saralaVoicePermission ?? "granted",
    devices: async () => ["MacBook Pro Microphone", "USB Microphone"],
    prepare: async (model) => {
      if (loaded !== model) { loaded = model; emit({ kind: "loaded", model, ms: 5, backend: "mock" }); }
    },
    start: async (model) => {
      if (!installed.has(model)) throw new Error("model-missing");
      const perm = w.__saralaVoicePermission ?? "granted";
      if (perm === "denied" || perm === "restricted") throw new Error("permission-denied");
      stopTimer();
      if (w.__saralaVoiceOpenDelay) await new Promise((r) => setTimeout(r, w.__saralaVoiceOpenDelay));
      w.__saralaVoiceMicOpen = true;
      if (loaded !== model) {
        emit({ kind: "phase", phase: "loading" });
        loaded = model;
        emit({ kind: "loaded", model, ms: 5, backend: "mock" });
      }
      emit({ kind: "phase", phase: "listening" });
      script = w.__saralaVoiceSilent ? [] : (w.__saralaVoiceScript ?? DEFAULT_SCRIPT).split(" ");
      heard = [];
      committed = 0;
      let pos = 0;
      let wait = 0;
      let speaking = false;
      timer = window.setInterval(() => {
        const next = script[pos];
        const talking = next !== undefined && next !== "|" && wait === 0;
        emit({ kind: "level", level: w.__saralaVoiceDeadMic ? 0 : talking ? 0.4 + Math.random() * 0.5 : 0.05 });
        if (wait > 0) { wait--; return; }
        if (next === undefined || next === "|") {
          if (speaking) { speaking = false; emit({ kind: "speech", speaking: false }); }
          if (next === "|") { pos++; wait = w.__saralaVoicePauseTicks ?? 12; }
          return;
        }
        if (!speaking) { speaking = true; emit({ kind: "speech", speaking: true }); }
        pos++;
        heard.push(next);
        const mine = heard.slice(committed);
        emit({ kind: "text", committed: mine.slice(0, -1).join(" "), tentative: ` ${next}` });
      }, w.__saralaVoiceDelay ?? 120);
    },
    stop: async () => {
      stopTimer();
      emit({ kind: "phase", phase: "transcribing" });
      emit({ kind: "level", level: 0 });
      await new Promise((r) => setTimeout(r, 30));
      // A stop arrives a moment after the last word: the final pass catches
      // up with everything said since the last commit.
      return heard.length > committed ? words().slice(committed).join(" ") : "";
    },
    commit: async () => {
      await new Promise((r) => setTimeout(r, 20));
      const text = heard.slice(committed).join(" ");
      committed = heard.length;
      emit({ kind: "text", committed: "", tentative: "" });
      return text;
    },
    cancel: async () => { stopTimer(); emit({ kind: "level", level: 0 }); },
    unload: async () => { loaded = ""; emit({ kind: "unloaded" }); },
    setIdle: async () => {},
    onEvent: async (cb) => { events.add(cb); return () => events.delete(cb); },
    onDownload: async (cb) => { downloads.add(cb); return () => downloads.delete(cb); },
  };
}
