/**
 * Text decoding and encoding. UTF-8, nearly every Markdown file, needs nothing
 * beyond the platform. Anything else (or a forced label, or a legacy save) goes
 * through wasm/, the Rust crates the desktop uses, fetched only then.
 */
import type { EncodedDoc } from "../../src/platform";

const BASE = import.meta.env.BASE_URL;

interface Exports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  decode(ptr: number, len: number, labelPtr: number, labelLen: number): bigint;
  encode(ptr: number, len: number, labelPtr: number, labelLen: number, bom: number): bigint;
}

let module: Promise<Exports> | null = null;
function wasm(): Promise<Exports> {
  // Not instantiateStreaming: it demands the application/wasm type, and static
  // hosts don't all send it.
  module ??= fetch(`${BASE}wasm/encoding.wasm`)
    .then((response) => response.arrayBuffer())
    .then((bytes) => WebAssembly.instantiate(bytes))
    .then(({ instance }) => instance.exports as unknown as Exports)
    .catch((error) => { module = null; throw error; });
  return module;
}

/** Copy bytes into the module's memory for the length of `fn`. */
function withBytes<T>(w: Exports, bytes: Uint8Array, fn: (ptr: number, len: number) => T): T {
  const ptr = w.alloc(bytes.length);
  new Uint8Array(w.memory.buffer, ptr, bytes.length).set(bytes);
  try { return fn(ptr, bytes.length); } finally { w.dealloc(ptr, bytes.length); }
}

/** Copy a result out and free it. The view must be taken after the call: growth
 *  during decode or encode detaches any view of the old memory. */
function takeResult(w: Exports, packed: bigint): Uint8Array {
  const ptr = Number(packed >> 32n);
  const len = Number(packed & 0xffffffffn);
  const out = new Uint8Array(w.memory.buffer, ptr, len).slice();
  w.dealloc(ptr, len);
  return out;
}

const utf8 = new TextEncoder();
const STATUS_OK = 0;

async function decodeWasm(bytes: Uint8Array, label: string): Promise<EncodedDoc> {
  const w = await wasm();
  const out = withBytes(w, bytes, (ptr, len) =>
    withBytes(w, utf8.encode(label), (labelPtr, labelLen) => takeResult(w, w.decode(ptr, len, labelPtr, labelLen))));
  if (out[0] !== STATUS_OK) throw new Error(`Unknown encoding: ${label}`);
  const flags = out[1];
  const nameLen = out[2];
  return {
    encoding: new TextDecoder().decode(out.subarray(3, 3 + nameLen)),
    content: new TextDecoder().decode(out.subarray(3 + nameLen)),
    lossy: (flags & 1) !== 0,
    hadBom: (flags & 2) !== 0,
  };
}

export async function decode(bytes: Uint8Array, label = ""): Promise<EncodedDoc> {
  if (!label) {
    try {
      // ignoreBOM keeps U+FEFF in the output, which is how a BOM shows up here.
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      const hadBom = text.charCodeAt(0) === 0xfeff;
      return { content: hadBom ? text.slice(1) : text, encoding: "UTF-8", hadBom, lossy: false };
    } catch { /* not UTF-8: detect it */ }
  }
  return decodeWasm(bytes, label);
}

export async function encode(text: string, label: string, bom: boolean): Promise<Blob> {
  if (/^utf-?8$/i.test(label)) return new Blob(bom ? ["﻿", text] : [text]);
  const w = await wasm();
  const out = withBytes(w, utf8.encode(text), (ptr, len) =>
    withBytes(w, utf8.encode(label), (labelPtr, labelLen) => takeResult(w, w.encode(ptr, len, labelPtr, labelLen, bom ? 1 : 0))));
  if (out[0] !== STATUS_OK) throw new Error(`Unknown encoding: ${label}`);
  return new Blob([out.slice(1)]);
}
