import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
const outfile = fileURLToPath(new URL("./.build/fileopen.mjs", import.meta.url));
await build({ entryPoints: ["src/fileopen.ts"], bundle: true, format: "esm", outfile });
const { connectFileOpen } = await import(outfile);
let notify;
let unlistened = false;
let queue = ["/tmp/first file.md", "/tmp/日本語.md"];
const opened = [];
let release;
const blocked = new Promise((resolve) => { release = resolve; });
const errors = [];
const stop = await connectFileOpen(
  async (callback) => { notify = callback; return () => { unlistened = true; }; },
  async () => { const paths = queue; queue = []; return paths; },
  async (path) => {
    opened.push(path);
    if (path.endsWith("first file.md")) await blocked;
    if (path.endsWith("unreadable.md")) throw new Error("unreadable");
  },
  (error) => errors.push(error.message),
);
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(opened, ["/tmp/first file.md"]);
queue.push("/tmp/unreadable.md", "/tmp/later.markdown");
notify(); notify();
release();
await new Promise((resolve) => setImmediate(resolve));
assert.deepEqual(opened, ["/tmp/first file.md", "/tmp/日本語.md", "/tmp/unreadable.md", "/tmp/later.markdown"]);
assert.deepEqual(errors, ["unreadable"]);
stop();
queue.push("/tmp/closed.md");
notify();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(opened.length, 4);
assert.equal(unlistened, true);
console.log("Finder file-open startup, serialization, errors and cleanup checks passed");
