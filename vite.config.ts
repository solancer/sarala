import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

export default defineConfig({
  plugins: [solid()],
  clearScreen: false,
  // Baked in at build time. The Flatpak build sets SARALA_FLATPAK=1 (see
  // flatpak/io.github.solancer.Sarala.yml); everywhere else it's false. Used to
  // suppress the in-app updater, since Flathub manages updates itself.
  define: {
    __SARALA_FLATPAK__: JSON.stringify(process.env.SARALA_FLATPAK === "1"),
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: { target: "es2022" },
});
