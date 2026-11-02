import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import solid from "vite-plugin-solid";

const here = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(resolve(here, "package.json"), "utf8"));

/** Above this a file is cached on first use instead (the D2 engine, speech). */
const PRECACHE_LIMIT = 2_000_000;

/**
 * Emit the service worker with this build's file list. What it leaves out
 * (Pandoc, the speech runtime) is large, optional and cached on first use.
 */
function serviceWorker(): Plugin {
  return {
    name: "sarala-sw",
    apply: "build",
    generateBundle(_, bundle) {
      // transformers.js references its runtime so a bundler will emit it, but
      // the runtime loads from ort/ (see voice/backend.ts). Don't ship it twice.
      for (const name of Object.keys(bundle)) if (/^assets\/ort-wasm.*\.wasm$/.test(name)) delete bundle[name];
      const size = (f: string) => {
        const item = bundle[f];
        return item.type === "chunk" ? item.code.length : item.source.length;
      };
      const assets = Object.keys(bundle).filter((f) => !f.endsWith(".map") && size(f) < PRECACHE_LIMIT);
      const list = ["./", ...assets, "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "wasm/encoding.wasm", "voice-capture.js"];
      const key = Object.keys(bundle).sort().join("\n").length.toString(36) + "-" + Date.now().toString(36);
      const source = readFileSync(resolve(here, "src/sw.js"), "utf8")
        .replace("__PRECACHE__", JSON.stringify(list))
        .replace("__BUILD__", JSON.stringify(key));
      this.emitFile({ type: "asset", fileName: "sw.js", source });
    },
  };
}

export default defineConfig({
  root: here,
  // Relative, so a build works at a domain root or under /sarala/ on Pages.
  base: "./",
  plugins: [solid(), serviceWorker()],
  clearScreen: false,
  define: {
    __SARALA_FLATPAK__: "false",
    __SARALA_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      // The package's own browser entry fetches its 58 MB binary on import.
      // Sarala decides when that happens, so it starts from the core instead.
      "pandoc-wasm/core": resolve(here, "node_modules/pandoc-wasm/src/core.js"),
    },
  },
  worker: { format: "es" },
  server: { port: 1421, strictPort: true, fs: { allow: [".."] } },
  preview: { port: 1422, strictPort: true },
  build: { target: "es2022", outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 4000 },
});
