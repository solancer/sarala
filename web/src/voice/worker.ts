/// <reference lib="webworker" />
/** Speech recognition on this device, in a worker so typing never stutters. The
 *  model comes from Hugging Face once; audio is never sent anywhere. */
import { env, pipeline } from "@huggingface/transformers";

export interface LoadRequest {
  type: "load";
  repo: string;
  device: "webgpu" | "wasm";
  dtype: Record<string, string>;
  /** Absolute URL of the ONNX Runtime files shipped with the app. */
  runtime: string;
}
export interface TranscribeRequest { type: "transcribe"; id: number; audio: Float32Array; language: string | null }

type Recognizer = (audio: Float32Array, options: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let recognizer: Recognizer | null = null;
let multilingual = false;

const loaded = new Map<string, { loaded: number; total: number }>();

async function load(req: LoadRequest) {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.backends.onnx.wasm!.wasmPaths = req.runtime;
  env.backends.onnx.wasm!.proxy = false;
  multilingual = req.repo.includes("whisper");
  const started = performance.now();
  const options = {
    device: req.device,
    dtype: req.dtype,
    progress_callback: (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (p.status !== "progress" || !p.file) return;
      loaded.set(p.file, { loaded: p.loaded ?? 0, total: p.total ?? 0 });
      const all = [...loaded.values()];
      self.postMessage({ type: "progress", received: all.reduce((n, f) => n + f.loaded, 0), total: all.reduce((n, f) => n + f.total, 0) });
    },
  };
  recognizer = (await pipeline("automatic-speech-recognition", req.repo, options as never)) as unknown as Recognizer;
  self.postMessage({ type: "ready", ms: Math.round(performance.now() - started) });
}

async function transcribe(req: TranscribeRequest) {
  if (!recognizer) throw new Error("The speech model isn't loaded.");
  const options: Record<string, unknown> = { chunk_length_s: 30, stride_length_s: 5 };
  if (multilingual) {
    options.task = "transcribe";
    if (req.language) options.language = req.language;
  }
  const result = await recognizer(req.audio, options);
  const text = Array.isArray(result) ? result.map((r) => r.text).join(" ") : result.text;
  self.postMessage({ type: "text", id: req.id, text });
}

// One job at a time: a model session can't run twice at once, and a live
// preview may still be running when the final pass arrives.
let queue: Promise<unknown> = Promise.resolve();

self.onmessage = (e: MessageEvent<LoadRequest | TranscribeRequest>) => {
  const req = e.data;
  queue = queue.then(() => (req.type === "load" ? load(req) : transcribe(req))).catch((error) => {
    self.postMessage({ type: "error", id: req.type === "transcribe" ? req.id : undefined, message: String(error?.message ?? error) });
  });
};
