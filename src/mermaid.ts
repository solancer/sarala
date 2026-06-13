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
  const mermaid = await getMermaid();
  const theme = currentTheme();
  if (initializedTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, theme, securityLevel: "strict" });
    initializedTheme = theme;
  }
  for (const node of nodes) {
    if (node.dataset.rendered === "1") continue;
    const src = node.getAttribute("data-mermaid") ?? "";
    try {
      const { svg } = await mermaid.render(`sarala-mmd-${++seq}`, src);
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
    }
  }
}
