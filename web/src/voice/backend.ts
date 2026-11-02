/**
 * Voice typing in the browser, behind the same Backend the Rust pipeline
 * implements, so the session, the set-up flow and the HUD are unchanged.
 *
 * The microphone runs from `start`; audio collects while a small energy gate
 * reports speech and pauses. While someone speaks, previews of the audio so far
 * write the words into the document. A pause makes the session call `commit`,
 * which sends what was said to the recognizer, like the desktop's non-streaming
 * models.
 */
import type { Backend, DownloadEvent, VoiceEvent, VoiceModel } from "../../../src/voice/transport";

type Device = "webgpu" | "wasm";

interface Spec {
  id: string; label: string; blurb: string; languages: string; license: string; repo: string;
  /** Per runtime: quantized models run on the CPU, full ones suit a GPU. */
  files: Record<Device, { dtype: Record<string, string>; size: number }>;
}

const MODELS: Spec[] = [
  {
    id: "moonshine-base", label: "Moonshine Base (English)", blurb: "Small and quick. Text appears when you pause.",
    languages: "en", license: "MIT (Useful Sensors)", repo: "onnx-community/moonshine-base-ONNX",
    files: {
      wasm: { dtype: { encoder_model: "q8", decoder_model_merged: "q8" }, size: 63_000_000 },
      webgpu: { dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, size: 154_000_000 },
    },
  },
  {
    id: "whisper-base", label: "Whisper Base", blurb: "About 99 languages. Text appears when you pause.",
    languages: "multi", license: "Apache-2.0 (OpenAI)", repo: "onnx-community/whisper-base",
    files: {
      wasm: { dtype: { encoder_model: "q8", decoder_model_merged: "q8" }, size: 77_000_000 },
      webgpu: { dtype: { encoder_model: "fp32", decoder_model_merged: "q4" }, size: 206_000_000 },
    },
  },
];

const INSTALLED_KEY = "sarala.voiceModels";
const MODEL_CACHE = "transformers-cache";
const RATE = 16_000;

function installedSet(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(INSTALLED_KEY) ?? "[]")); } catch { return new Set(); }
}
function setInstalled(id: string, on: boolean) {
  const set = installedSet();
  if (on) set.add(id); else set.delete(id);
  localStorage.setItem(INSTALLED_KEY, JSON.stringify([...set]));
}

interface GpuAdapter { isFallbackAdapter?: boolean; info?: { isFallbackAdapter?: boolean } }

let device: Promise<Device> | null = null;
function bestDevice(): Promise<Device> {
  device ??= (async () => {
    const adapter = await navigator.gpu?.requestAdapter().catch(() => null) as GpuAdapter | null | undefined;
    // A software adapter is the CPU with extra steps: far slower than WASM.
    if (!adapter || adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) return "wasm" as const;
    return "webgpu" as const;
  })();
  return device;
}

/* ---------- microphone ---------- */

/** Average down to the recognizer's rate. A shared AudioContext at 16 kHz would
 *  be simpler, but Firefox refuses to connect a stream at another rate. */
function downsample(input: Float32Array, from: number): Float32Array {
  if (from === RATE) return input;
  const ratio = from / RATE;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    out[i] = sum / Math.max(1, end - start);
  }
  return out;
}

class Mic {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;

  async open(deviceLabel: string | null, onAudio: (chunk: Float32Array) => void) {
    const id = deviceLabel
      ? (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && d.label === deviceLabel)?.deviceId
      : undefined;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: id, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      const name = (error as DOMException).name;
      if (name === "NotAllowedError" || name === "SecurityError") throw new Error("permission-denied");
      throw new Error(`Could not open the microphone: ${(error as Error).message}`);
    }
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule(`${import.meta.env.BASE_URL}voice-capture.js`);
    const node = new AudioWorkletNode(this.context, "voice-capture", { numberOfOutputs: 0 });
    const rate = this.context.sampleRate;
    node.port.onmessage = (e: MessageEvent<Float32Array>) => onAudio(downsample(e.data, rate));
    this.context.createMediaStreamSource(this.stream).connect(node);
  }

  close() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.context?.close().catch(() => {});
    this.stream = null;
    this.context = null;
  }
}

/** How often the words on screen catch up with the speaker. */
const PREVIEW_MS = 800;
/** Past this much speech (at 50 ms a chunk) previews take too long to be worth
 *  it, like the desktop's. The words arrive at the next pause or at the end. */
const PREVIEW_CHUNKS = 600;

const joined = (chunks: Float32Array[]) => {
  const audio = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { audio.set(c, at); at += c.length; }
  return audio;
};

const rms = (chunk: Float32Array) => {
  let sum = 0;
  for (const v of chunk) sum += v * v;
  return Math.sqrt(sum / Math.max(1, chunk.length));
};
const toLevel = (value: number) => Math.min(1, Math.pow(value * 8, 0.6));

/* ---------- recognizer ---------- */

/** What a recognizer says for silence or noise, which should never be typed. */
const NON_SPEECH = /^\s*[[(][^\])]*[\])]\s*$/;
const clean = (text: string) => (NON_SPEECH.test(text) ? "" : text.replace(/\s*\[BLANK_AUDIO\]\s*/gi, " ").trim());

class Recognizer {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 0;
  private waiting = new Map<number, { resolve(text: string): void; reject(e: Error): void }>();
  loaded = "";

  async load(spec: Spec, onProgress: (received: number, total: number) => void, onReady: (ms: number, backend: string) => void): Promise<void> {
    if (this.ready && this.loaded === spec.id) return this.ready;
    const runtime = await bestDevice();
    return this.start(spec, runtime, onProgress, onReady).catch((error) => {
      if (runtime !== "webgpu") throw error;
      // A driver can pass the adapter check and still fail on a real model.
      device = Promise.resolve("wasm");
      return this.start(spec, "wasm", onProgress, onReady);
    });
  }

  private start(spec: Spec, runtimeDevice: Device, onProgress: (received: number, total: number) => void, onReady: (ms: number, backend: string) => void): Promise<void> {
    this.dispose();
    this.loaded = spec.id;
    const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker = worker;
    this.ready = new Promise<void>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m.type === "progress") onProgress(m.received, m.total);
        else if (m.type === "ready") { onReady(m.ms, runtimeDevice); resolve(); }
        else if (m.type === "text") { this.waiting.get(m.id)?.resolve(clean(m.text)); this.waiting.delete(m.id); }
        else if (m.type === "error") {
          if (m.id === undefined) { this.dispose(); reject(new Error(m.message)); return; }
          this.waiting.get(m.id)?.reject(new Error(m.message));
          this.waiting.delete(m.id);
        }
      };
      worker.onerror = (e) => { this.dispose(); reject(new Error(e.message || "The speech model stopped.")); };
      worker.postMessage({
        type: "load",
        repo: spec.repo,
        device: runtimeDevice,
        dtype: spec.files[runtimeDevice].dtype,
        runtime: new URL(`${import.meta.env.BASE_URL}ort/`, location.href).href,
      });
    });
    return this.ready;
  }

  async transcribe(audio: Float32Array, language: string | null): Promise<string> {
    await this.ready;
    if (!this.worker) throw new Error("The speech model isn't loaded.");
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.worker!.postMessage({ type: "transcribe", id, audio, language }, [audio.buffer]);
    });
  }

  dispose() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = null;
    this.loaded = "";
    for (const entry of this.waiting.values()) entry.reject(new Error("Stopped."));
    this.waiting.clear();
  }
}

/* ---------- the backend ---------- */

function os() {
  return "web";
}

export function webVoiceBackend(): Backend {
  const events = new Set<(e: VoiceEvent) => void>();
  const downloads = new Set<(e: DownloadEvent) => void>();
  const micTests = new Set<(level: number) => void>();
  const emit = (e: VoiceEvent) => events.forEach((cb) => cb(e));

  const recognizer = new Recognizer();
  const mic = new Mic();
  const testMic = new Mic();

  let chunks: Float32Array[] = [];
  let heardSpeech = false;
  let previewTimer: ReturnType<typeof setInterval> | undefined;
  let previewing = false;
  let previewedChunks = 0;
  let previewAfter = 0;
  /** Bumped when the audio is taken or dropped: a preview still running is stale. */
  let previewRun = 0;
  let language: string | null = null;
  let speaking = false;
  let quietChunks = 0;
  let loudChunks = 0;
  let noiseFloor = 0.004;
  let activeDownload: { spec: Spec; cancel(): void } | null = null;
  let idleMinutes: number | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const specFor = (id: string) => {
    const spec = MODELS.find((m) => m.id === id);
    if (!spec) throw new Error("model-missing");
    return spec;
  };

  const onLoaded = (id: string) => (ms: number, backend: string) => emit({ kind: "loaded", model: id, ms, backend });

  /** One 50 ms chunk: a level for the HUD, and a verdict on speech. Half a
   *  second of quiet ends speech; the floor adapts so a fan doesn't count. */
  const hear = (chunk: Float32Array) => {
    const value = rms(chunk);
    chunks.push(chunk);
    emit({ kind: "level", level: toLevel(value) });
    const loud = value > Math.max(0.01, noiseFloor * 2.5);
    if (!loud) noiseFloor += (value - noiseFloor) * 0.05;
    loudChunks = loud ? loudChunks + 1 : 0;
    quietChunks = loud ? 0 : quietChunks + 1;
    if (!speaking && loudChunks >= 3) {
      speaking = true;
      heardSpeech = true;
      emit({ kind: "speech", speaking: true });
    } else if (speaking && quietChunks >= 10) {
      speaking = false;
      emit({ kind: "speech", speaking: false });
    }
  };

  /** Recognize the speech so far, so the words appear while they are spoken.
   *  The model has no streaming mode, so this runs over all of it each time;
   *  it takes at most a third of the time, so a slow device never falls behind. */
  const preview = async () => {
    const taken = chunks;
    if (previewing || performance.now() < previewAfter) return;
    if (!heardSpeech || taken.length === previewedChunks || taken.length > PREVIEW_CHUNKS) return;
    previewing = true;
    const started = performance.now();
    previewedChunks = taken.length;
    const run = previewRun;
    try {
      const text = await recognizer.transcribe(joined(taken), language);
      if (run === previewRun && text) emit({ kind: "text", committed: "", tentative: text });
    } catch {
      // Only a preview: the final pass reports anything that is really wrong.
    } finally {
      previewing = false;
      previewAfter = performance.now() + (performance.now() - started) * 2;
    }
  };

  /** Take what was said since the last call. Silence never reaches the model,
   *  which would otherwise invent words for it. */
  const drain = async () => {
    const taken = chunks;
    const spoke = heardSpeech;
    chunks = [];
    heardSpeech = speaking;
    previewRun++;
    previewedChunks = 0;
    if (!spoke || !taken.length) return "";
    return recognizer.transcribe(joined(taken), language);
  };

  const armIdle = () => {
    clearTimeout(idleTimer);
    if (idleMinutes === null) return;
    idleTimer = setTimeout(() => {
      recognizer.dispose();
      emit({ kind: "unloaded" });
    }, idleMinutes * 60_000);
  };

  return {
    supported: async () => typeof AudioWorkletNode !== "undefined" && !!navigator.mediaDevices,
    platform: async () => ({
      os: os(),
      sandbox: null,
      unsupported: typeof AudioWorkletNode === "undefined" || !navigator.mediaDevices
        ? "This browser can't capture audio for voice typing."
        : null,
    }),
    async models(): Promise<VoiceModel[]> {
      const installed = installedSet();
      const where = await bestDevice();
      return MODELS.map((m) => ({
        id: m.id, label: m.label, blurb: m.blurb, languages: m.languages, license: m.license,
        streaming: false, size: m.files[where].size, installed: installed.has(m.id), partial: 0,
      }));
    },
    download(model) {
      const spec = specFor(model);
      const send = (phase: DownloadEvent["phase"], received: number, total: number, message: string | null = null) =>
        downloads.forEach((cb) => cb({ model, phase, received, total, message }));
      return new Promise<void>((resolve, reject) => {
        activeDownload = {
          spec,
          cancel() {
            recognizer.dispose();
            activeDownload = null;
            send("cancelled", 0, 0);
            reject(new Error("cancelled"));
          },
        };
        let last = 0;
        recognizer.load(spec, (received, total) => { last = total; send("download", received, total); }, onLoaded(model)).then(() => {
          activeDownload = null;
          setInstalled(model, true);
          send("done", last, last);
          resolve();
        }, (error) => {
          if (!activeDownload) return;
          activeDownload = null;
          send("error", 0, 0, String(error.message ?? error));
          reject(error);
        });
      });
    },
    cancelDownload: async () => activeDownload?.cancel(),
    async deleteModel(model) {
      const spec = specFor(model);
      if (recognizer.loaded === model) recognizer.dispose();
      setInstalled(model, false);
      const cache = await caches.open(MODEL_CACHE);
      for (const request of await cache.keys()) {
        if (request.url.includes(`/${spec.repo}/`)) await cache.delete(request);
      }
    },
    async permission() {
      try {
        const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
        return status.state === "prompt" ? "undetermined" : status.state;
      } catch {
        return "unknown";
      }
    },
    async requestPermission() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach((t) => t.stop());
        return "granted";
      } catch {
        return "denied";
      }
    },
    async devices() {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter((d) => d.kind === "audioinput" && d.label && d.deviceId !== "default").map((d) => d.label);
    },
    async micTestStart(deviceLabel) {
      testMic.close();
      await testMic.open(deviceLabel, (chunk) => { const level = toLevel(rms(chunk)); micTests.forEach((cb) => cb(level)); });
    },
    micTestStop: async () => testMic.close(),
    onMicTest: async (cb) => { micTests.add(cb); return () => micTests.delete(cb); },
    async prepare(model) {
      // Always announces: a download already loads the model, so "loaded" may
      // have fired before the set-up flow started listening for it.
      let announced = false;
      const announce = onLoaded(model);
      await recognizer.load(specFor(model), () => {}, (ms, backend) => { announced = true; announce(ms, backend); });
      if (!announced) announce(0, await bestDevice());
    },
    async start(model, deviceLabel, lang) {
      if (!installedSet().has(model)) throw new Error("model-missing");
      clearTimeout(idleTimer);
      testMic.close();
      chunks = [];
      heardSpeech = false;
      speaking = false;
      loudChunks = quietChunks = 0;
      language = lang;
      // Open the microphone first: words said while the model loads still count.
      await mic.open(deviceLabel, hear);
      previewedChunks = 0;
      clearInterval(previewTimer);
      previewTimer = setInterval(() => void preview(), PREVIEW_MS);
      if (recognizer.loaded !== model) emit({ kind: "phase", phase: "loading" });
      void recognizer.load(specFor(model), () => {}, onLoaded(model))
        .then(() => emit({ kind: "phase", phase: "listening" }))
        .catch((error) => emit({ kind: "error", message: String(error.message ?? error) }));
    },
    async stop() {
      clearInterval(previewTimer);
      mic.close();
      emit({ kind: "phase", phase: "transcribing" });
      emit({ kind: "level", level: 0 });
      speaking = false;
      const text = await drain();
      armIdle();
      return text;
    },
    async commit() {
      const text = await drain();
      emit({ kind: "text", committed: "", tentative: "" });
      return text;
    },
    async cancel() {
      clearInterval(previewTimer);
      previewRun++;
      mic.close();
      chunks = [];
      heardSpeech = speaking = false;
      emit({ kind: "level", level: 0 });
      armIdle();
    },
    async unload() {
      recognizer.dispose();
      emit({ kind: "unloaded" });
    },
    async setIdle(minutes) {
      idleMinutes = minutes !== null && minutes < 0 ? null : minutes;
    },
    onEvent: async (cb) => { events.add(cb); return () => events.delete(cb); },
    onDownload: async (cb) => { downloads.add(cb); return () => downloads.delete(cb); },
  };
}
