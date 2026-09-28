import { applyLegacyLinks, type LegacyLink } from "./legacydiagrams";
/**
 * Mermaid diagram rendering for ```mermaid blocks. Mermaid is async (unlike
 * KaTeX), so renderMarkdown only emits a placeholder div; this module renders
 * the SVG into it after the rendered view is in the DOM. Mermaid is lazily
 * imported so its weight is only paid once a diagram actually appears.
 */

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

type MermaidApi = {
  initialize: (cfg: Record<string, unknown>) => void;
  render: (id: string, src: string) => Promise<{ svg: string }>;
};

let mermaidMod: MermaidApi | null = null;
let initializedTheme: string | null = null;
let seq = 0;
// Last good SVG per block, so a syntax error mid-edit keeps the diagram.
const lastGoodSvg = new Map<string, string>();
// Rendered SVG keyed by theme + source (+ legacy link metadata).
const svgCache = new Map<string, string>();

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidMod) {
    mermaidMod = (await import("mermaid")).default as unknown as MermaidApi;
  }
  return mermaidMod;
}

/**
 * Mermaid theme from the --mermaid-theme CSS var (dark in dark themes). Read
 * once per task: every diagram block calls this, and each read forces a style
 * recalc after the previous block's SVG dirtied the DOM — dozens of forced
 * recalcs on a tab switch. A theme change re-renders in a later task anyway.
 */
let themeThisTask: string | null = null;
function currentTheme(): string {
  if (themeThisTask === null) {
    const host = document.querySelector(".app") ?? document.documentElement;
    themeThisTask = getComputedStyle(host).getPropertyValue("--mermaid-theme").trim() || "default";
    setTimeout(() => { themeThisTask = null; });
  }
  return themeThisTask;
}

/*
 * Every Mermaid SVG carries its own <style>, scoped by the SVG's unique id
 * (`#sarala-mmd-7 .node rect {...}`). In the editor each of those is a
 * document-wide stylesheet, so N diagrams make every style recalc match all
 * SVG nodes against N copies of nearly the same rules. Sharing rewrites each
 * sheet onto a class named by its content and keeps one copy per distinct
 * sheet in <head>. `:is(#never, .cls)` preserves the id-level specificity the
 * rules had. Export leaves the inline <style> alone so its HTML stays
 * self-contained.
 */
const sharedSheets = new Map<string, string>();
let sharedStyle: HTMLStyleElement | null = null;
function shareSvgStyles(node: HTMLElement) {
  const svg = node.querySelector("svg");
  if (!svg?.id) return;
  const scope = new RegExp(`#${svg.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "g");
  for (const style of svg.querySelectorAll("style")) {
    const css = (style.textContent ?? "").replace(scope, "\u0000");
    let cls = sharedSheets.get(css);
    if (!cls) {
      cls = `mmd-sheet-${sharedSheets.size}`;
      sharedSheets.set(css, cls);
      if (!sharedStyle?.isConnected) {
        sharedStyle = document.createElement("style");
        sharedStyle.id = "mermaid-shared-styles";
        document.head.appendChild(sharedStyle);
      }
      sharedStyle.append(css.replaceAll("\u0000", `:is(#${cls}-never, .${cls})`) + "\n");
    }
    svg.classList.add(cls);
    style.remove();
  }
}

/**
 * Render every .mermaid-block inside `container`. On a syntax error, show the
 * block's last good diagram (if any) plus an inline error — never blank.
 * `shareStyles` hoists each SVG's stylesheet (editor only, see above).
 */
export async function renderMermaidIn(container: HTMLElement, blockKey?: string, shareStyles = false): Promise<void> {
  const all = [...container.querySelectorAll<HTMLElement>(".mermaid-block[data-mermaid]")];
  if (!all.length) return;
  // Fill diagrams already rendered for this theme synchronously, before any
  // await, so a remounted block (tab switch, re-render) paints them in the
  // same frame instead of flashing empty while Mermaid lays them out again.
  const cacheTheme = currentTheme();
  const nodes = all.filter((node) => {
    if (node.dataset.rendered === "1") return false;
    const svg = svgCache.get(`${cacheTheme}\0${node.getAttribute("data-mermaid") ?? ""}\0${node.dataset.legacyLinks ?? ""}`);
    if (svg === undefined) return true;
    node.innerHTML = svg;
    if (shareStyles) shareSvgStyles(node);
    node.dataset.rendered = "1";
    if (blockKey != null) lastGoodSvg.set(blockKey, svg);
    return false;
  });
  if (!nodes.length) return;
  // Keep the previous diagram on screen (dimmed) while the new source lays
  // out, instead of collapsing to a "Rendering…" placeholder on every edit.
  for (const node of nodes) {
    const last = blockKey != null && !node.firstChild ? lastGoodSvg.get(blockKey) : undefined;
    if (!last) continue;
    node.innerHTML = last;
    if (shareStyles) shareSvgStyles(node);
    node.classList.add("diagram-pending");
  }
  // Clear any orphaned Mermaid measuring/error nodes left on <body> by a prior
  // failed render (these are the stray full-page "bomb" graphics).
  document.querySelectorAll('body > [id^="sarala-mmd-"], body > [id^="dsarala-mmd-"]')
    .forEach((n) => n.remove());
  const mermaid = await getMermaid();
  const theme = currentTheme();
  if (initializedTheme !== theme) {
    // suppressErrorRendering: don't inject Mermaid's full-page "bomb" error
    // graphic on a parse failure — we show our own inline error instead.
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: "strict",
      suppressErrorRendering: true,
    });
    initializedTheme = theme;
  }
  for (const node of nodes) {
    if (node.dataset.rendered === "1") continue;
    const src = node.getAttribute("data-mermaid") ?? "";
    const id = `sarala-mmd-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, src);
      node.innerHTML = svg;
      if (node.dataset.legacyLinks) {
        try { const links = JSON.parse(node.dataset.legacyLinks) as LegacyLink[]; if (Array.isArray(links)) applyLegacyLinks(node, links); } catch { /* Invalid metadata cannot alter the SVG. */ }
      }
      node.dataset.rendered = "1";
      if (svgCache.size > 300) svgCache.clear();
      svgCache.set(`${theme}\0${src}\0${node.dataset.legacyLinks ?? ""}`, node.innerHTML);
      if (blockKey != null) lastGoodSvg.set(blockKey, node.innerHTML);
      if (shareStyles) shareSvgStyles(node);
      node.classList.remove("diagram-pending");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const last = blockKey != null ? lastGoodSvg.get(blockKey) : undefined;
      node.innerHTML =
        (last ?? "") +
        `<div class="render-error">⚠ Mermaid error: ${escapeHtml(msg)}</div>`;
      if (shareStyles) shareSvgStyles(node);
      node.classList.remove("diagram-pending");
      node.dataset.rendered = "1";
    } finally {
      // Mermaid appends a temporary measuring node to <body>; on a parse error
      // it can be orphaned (the stray bomb SVGs). Remove it — but only if it's
      // still loose on <body>, never the SVG we just injected into `node`
      // (Mermaid gives the rendered SVG this same id).
      document.getElementById(`d${id}`)?.remove();
      const stray = document.getElementById(id);
      if (stray && stray.parentElement === document.body) stray.remove();
    }
  }
}
