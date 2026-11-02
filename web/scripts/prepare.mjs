// Fill public/ (git-ignored) with the build's binaries. The encoding module
// needs the Rust target:  rustup target add wasm32-unknown-unknown
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const out = (path) => fileURLToPath(new URL(`../public/${path}`, import.meta.url));

// A Homebrew cargo ahead of rustup on PATH has no wasm standard library, so ask
// rustup for its compiler when rustup is installed.
const env = { ...process.env };
try {
  env.RUSTC = execFileSync("rustup", ["which", "rustc"], { encoding: "utf8" }).trim();
  // Its bundled linker finds libLLVM through a path that isn't always valid on
  // macOS, so name the toolchain's library folder as a fallback.
  env.DYLD_FALLBACK_LIBRARY_PATH = `${env.RUSTC.replace(/\/bin\/rustc$/, "")}/lib`;
} catch { /* no rustup: use whatever cargo finds */ }

const crate = fileURLToPath(new URL("../wasm/", import.meta.url));
execFileSync("cargo", ["build", "--release", "--target", "wasm32-unknown-unknown"], { cwd: crate, stdio: "inherit", env });
mkdirSync(out("wasm"), { recursive: true });
copyFileSync(`${crate}target/wasm32-unknown-unknown/release/sarala_encoding.wasm`, out("wasm/encoding.wasm"));

// Everything else comes from installed packages. These have export maps that
// hide their files from require.resolve, so go by location.
const modules = fileURLToPath(new URL("../node_modules/", import.meta.url));

// Gzipped ahead of time, because not every host compresses a 58 MB download.
// The name is neutral so that a host won't treat it as a compressed encoding.
if (!existsSync(out("pandoc/pandoc.bin"))) {
  mkdirSync(out("pandoc"), { recursive: true });
  const wasm = readFileSync(`${modules}pandoc-wasm/src/pandoc.wasm`);
  writeFileSync(out("pandoc/pandoc.bin"), gzipSync(wasm, { level: 9 }));
}

// pnpm keeps a package's dependencies beside its real location.
const ort = `${realpathSync(`${modules}@huggingface/transformers`)}/../../onnxruntime-web`;
mkdirSync(out("ort"), { recursive: true });
for (const name of ["asyncify.mjs", "asyncify.wasm", "jsep.mjs", "jsep.wasm"]) {
  copyFileSync(`${ort}/dist/ort-wasm-simd-threaded.${name}`, out(`ort/ort-wasm-simd-threaded.${name}`));
}

// Hosting the app distributes these binaries, so their licences go with them.
// Pandoc is GPL-2.0-or-later; its source is at https://github.com/jgm/pandoc and
// the WebAssembly build's at https://github.com/pandoc/pandoc-wasm.
mkdirSync(out("licenses"), { recursive: true });
copyFileSync(`${modules}pandoc-wasm/LICENSE`, out("licenses/pandoc.txt"));
copyFileSync(`${realpathSync(`${modules}@huggingface/transformers`)}/LICENSE`, out("licenses/transformers.txt"));
if (existsSync(`${ort}/LICENSE`)) copyFileSync(`${ort}/LICENSE`, out("licenses/onnxruntime.txt"));
else writeFileSync(out("licenses/onnxruntime.txt"), "ONNX Runtime Web is MIT licensed by Microsoft Corporation.\nhttps://github.com/microsoft/onnxruntime/blob/main/LICENSE\n");
