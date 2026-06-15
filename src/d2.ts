/**
 * D2 diagram rendering for ```d2 blocks. Like Mermaid, D2 is async — it runs a
 * WASM build of the Go compiler in a web worker — so renderMarkdown only emits
 * a placeholder div and this module fills it with SVG after the rendered view
 * is in the DOM. The library is lazily imported so its weight (a multi-MB,
 * self-contained bundle with the WASM inlined) is only paid once a D2 diagram
 * actually appears.
 */

import DOMPurify from "dompurify";

/**
 * D2's built-in theme catalog (id → display name), in the order D2's own
 * playground lists them. Used by the per-diagram theme picker; renderD2In only
 * needs the numeric id. IDs are stable D2 constants.
 */
export const D2_THEMES: { id: number; name: string }[] = [
  { id: 0, name: "Neutral default" },
  { id: 1, name: "Neutral gray" },
  { id: 3, name: "Flagship Terrastruct" },
  { id: 4, name: "Cool classics" },
  { id: 5, name: "Mixed berry blue" },
  { id: 6, name: "Grape soda" },
  { id: 7, name: "Aubergine" },
  { id: 8, name: "Colorblind clear" },
  { id: 100, name: "Vanilla nitro cola" },
  { id: 101, name: "Orange creamsicle" },
  { id: 102, name: "Shirley temple" },
  { id: 103, name: "Earth tones" },
  { id: 104, name: "Everglade green" },
  { id: 105, name: "Buttered toast" },
  { id: 200, name: "Dark mauve" },
  { id: 201, name: "Dark Flagship Terrastruct" },
  { id: 300, name: "Terminal" },
  { id: 301, name: "Terminal grayscale" },
  { id: 302, name: "Origami" },
];

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * D2 emits an <svg> with only a viewBox (no width/height), so it stretches to
 * fill the column — and a 100%-wide child cancels any CSS `zoom` on its parent.
 * Stamp the viewBox's pixel size onto the svg so it renders at natural size
 * (like Mermaid) and the .d2-block zoom can actually scale it.
 */
function withIntrinsicSize(svg: string): string {
  return svg.replace(/<svg\b([^>]*)>/, (tag, attrs: string) => {
    if (/\bwidth\s*=/.test(attrs)) return tag;
    const m = /viewBox\s*=\s*"[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)"/.exec(attrs);
    return m ? `<svg${attrs} width="${m[1]}" height="${m[2]}">` : tag;
  });
}

type CompileResult = { diagram: unknown; renderOptions: Record<string, unknown> };
type D2Instance = {
  compile: (src: string, opts?: Record<string, unknown>) => Promise<CompileResult>;
  render: (diagram: unknown, opts?: Record<string, unknown>) => Promise<string>;
};
type D2Ctor = new () => D2Instance;

let d2Instance: D2Instance | null = null;
// Last good SVG per block, so a syntax error mid-edit keeps the diagram.
const lastGoodSvg = new Map<string, string>();
// Compiled-SVG cache keyed by theme + source. Diagram size is applied as CSS
// (it leaves the source unchanged), so a zoom change re-renders the block but
// hits this cache instead of re-running the WASM compiler — no flicker.
const svgCache = new Map<string, string>();

async function getD2(): Promise<D2Instance> {
  if (!d2Instance) {
    const mod = (await import("@terrastruct/d2")) as unknown as { D2: D2Ctor };
    d2Instance = new mod.D2();
  }
  return d2Instance;
}

/**
 * Light/dark theme IDs from the --mermaid-theme CSS var (dark themes set it to
 * "dark"). 0 = Neutral default; 200 = Dark Mauve. Reusing the existing var
 * keeps both diagram engines on one theme switch.
 */
function currentTheme(): { themeID: number; darkThemeID: number } {
  const host = document.querySelector(".app") ?? document.documentElement;
  const v = getComputedStyle(host).getPropertyValue("--mermaid-theme").trim();
  return v === "dark" ? { themeID: 200, darkThemeID: 200 } : { themeID: 0, darkThemeID: 0 };
}

/**
 * Render every .d2-block inside `container`. On a compile/render error, show the
 * block's last good diagram (if any) plus an inline error — never blank.
 * Works on a detached container too (used by the export pipeline).
 */
export async function renderD2In(container: HTMLElement, blockKey?: string): Promise<void> {
  const nodes = [...container.querySelectorAll<HTMLElement>(".d2-block[data-d2]")];
  if (!nodes.length) return;
  const d2 = await getD2();
  const auto = currentTheme();
  for (const node of nodes) {
    if (node.dataset.rendered === "1") continue;
    const src = node.getAttribute("data-d2") ?? "";
    // A per-diagram `theme=NN` override (from the fence) pins both light and
    // dark to that theme; otherwise follow the app's light/dark default.
    const override = node.dataset.d2Theme ? Number(node.dataset.d2Theme) : null;
    const themeID = override ?? auto.themeID;
    const darkThemeID = override ?? auto.darkThemeID;
    const cacheKey = `${themeID}:${darkThemeID}:${src}`;
    try {
      let clean = svgCache.get(cacheKey);
      if (clean == null) {
        const result = await d2.compile(src, { layout: "dagre", themeID, darkThemeID, sketch: false });
        const svg = await d2.render(result.diagram, { ...result.renderOptions, noXMLTag: true });
        // D2 output is our own document's content, but sanitizing the SVG is
        // cheap insurance against a crafted label slipping script through.
        clean = withIntrinsicSize(DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } }));
        if (svgCache.size > 64) svgCache.clear(); // light bound; recompiles lazily
        svgCache.set(cacheKey, clean);
      }
      node.innerHTML = clean;
      node.dataset.rendered = "1";
      if (blockKey != null) lastGoodSvg.set(blockKey, clean);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const last = blockKey != null ? lastGoodSvg.get(blockKey) : undefined;
      node.innerHTML =
        (last ?? "") +
        `<div class="render-error">⚠ D2 error: ${escapeHtml(msg)}</div>`;
      node.dataset.rendered = "1";
    }
  }
}
