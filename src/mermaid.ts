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

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidMod) {
    mermaidMod = (await import("mermaid")).default as unknown as MermaidApi;
  }
  return mermaidMod;
}

/** Mermaid theme from the --mermaid-theme CSS var (dark in dark themes). */
function currentTheme(): string {
  const host = document.querySelector(".app") ?? document.documentElement;
  const v = getComputedStyle(host).getPropertyValue("--mermaid-theme").trim();
  return v || "default";
}

/**
 * Render every .mermaid-block inside `container`. On a syntax error, show the
 * block's last good diagram (if any) plus an inline error — never blank.
 */
export async function renderMermaidIn(container: HTMLElement, blockKey?: string): Promise<void> {
  const nodes = [...container.querySelectorAll<HTMLElement>(".mermaid-block[data-mermaid]")];
  if (!nodes.length) return;
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
      node.dataset.rendered = "1";
      if (blockKey != null) lastGoodSvg.set(blockKey, svg);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const last = blockKey != null ? lastGoodSvg.get(blockKey) : undefined;
      node.innerHTML =
        (last ?? "") +
        `<div class="render-error">⚠ Mermaid error: ${escapeHtml(msg)}</div>`;
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
