import { isTauri } from "./platform";

/**
 * System-font support. The webview can't enumerate installed fonts (WKWebView
 * has no Local Font Access API), so the list comes from the Rust
 * `list_system_fonts` command. Applying a font is just a CSS-variable swap —
 * a system family resolves by name with no loading. For exports, which must be
 * portable to machines without the font, `fontEmbedCss` pulls the actual glyph
 * data from Rust (`font_faces_b64`) and inlines `@font-face` data URIs.
 */

// The theme's default stacks (kept in sync with :root in styles/app.css), used
// as the fallback tail after a chosen family.
const PROSE_FALLBACK = `"Open Sans", "Clear Sans", "Helvetica Neue", Helvetica, Arial, sans-serif`;
const MONO_FALLBACK = `ui-monospace, "SF Mono", "Cascadia Code", Consolas, monospace`;

let cachedFamilies: string[] | null = null;

/** Installed font families (cached for the session). Empty in browser mode. */
export async function listSystemFonts(): Promise<string[]> {
  if (cachedFamilies) return cachedFamilies;
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  cachedFamilies = await invoke<string[]>("list_system_fonts").catch(() => []);
  return cachedFamilies;
}

function setVar(name: string, family: string | null, fallback: string) {
  const root = document.documentElement.style;
  if (family) root.setProperty(name, `"${family}", ${fallback}`);
  else root.removeProperty(name);
}

/** Live-apply the prose (writing surface) font. `null` restores the default. */
export function applyProseFont(family: string | null) {
  setVar("--font-prose", family, PROSE_FALLBACK);
}

/** Live-apply the code/mono font. `null` restores the default. */
export function applyMonoFont(family: string | null) {
  setVar("--font-mono", family, MONO_FALLBACK);
}

interface FontFace {
  weight: number;
  italic: boolean;
  format: string; // "truetype" | "opentype"
  b64: string;
}

async function facesFor(family: string): Promise<FontFace[]> {
  if (!isTauri) return [];
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<FontFace[]>("font_faces_b64", { family }).catch(() => []);
}

function escFamily(family: string): string {
  return family.replace(/["\\]/g, "\\$&");
}

/**
 * `@font-face` (data-URI) + variable-override CSS that embeds the chosen prose
 * and code fonts into an export so it renders the same on any machine. Appended
 * after the app stylesheet so the `:root` overrides win. Returns "" when no
 * custom font is set (or in browser mode).
 */
export async function fontEmbedCss(
  proseFamily: string | null,
  monoFamily: string | null,
): Promise<string> {
  let css = "";
  const embed = async (family: string, varName: string, fallback: string) => {
    const faces = await facesFor(family);
    if (!faces.length) return;
    const name = escFamily(family);
    for (const f of faces) {
      const mime = f.format === "opentype" ? "font/otf" : "font/ttf";
      css +=
        `@font-face{font-family:"${name}";font-weight:${f.weight};` +
        `font-style:${f.italic ? "italic" : "normal"};` +
        `src:url(data:${mime};base64,${f.b64}) format("${f.format}");}`;
    }
    css += `:root{${varName}:"${name}", ${fallback};}`;
  };
  if (proseFamily) await embed(proseFamily, "--font-prose", PROSE_FALLBACK);
  if (monoFamily) await embed(monoFamily, "--font-mono", MONO_FALLBACK);
  return css;
}
