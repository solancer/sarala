/// <reference lib="webworker" />
/** Pandoc compiled to WebAssembly. In a worker because it pauses the thread it
 *  runs on for seconds at a time, and instantiating it alone takes a while. */
import { createPandocInstance } from "pandoc-wasm/core";

type Instance = Awaited<ReturnType<typeof createPandocInstance>>;
let instance: Promise<Instance> | null = null;

/** Stored gzipped, but a host may have decoded it in transit (a CDN sending
 *  Content-Encoding: gzip), so go by the bytes and not the file's name. */
async function unpack(binary: Blob): Promise<ArrayBuffer> {
  const magic = new Uint8Array(await binary.slice(0, 2).arrayBuffer());
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) return binary.arrayBuffer();
  return new Response(binary.stream().pipeThrough(new DecompressionStream("gzip"))).arrayBuffer();
}

self.onmessage = async (e: MessageEvent) => {
  const { id, binary, options, stdin, files } = e.data as {
    id: number; binary: Blob; options: Record<string, unknown>; stdin: string | null; files: Record<string, Blob | string>;
  };
  try {
    instance ??= unpack(binary).then(createPandocInstance);
    const pandoc = await instance;
    const result = await pandoc.convert(options, stdin, files);
    self.postMessage({ id, stdout: result.stdout, stderr: result.stderr, files: result.files, media: result.mediaFiles });
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
