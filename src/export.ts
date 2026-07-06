/**
 * Export logic: HTML document assembly (with an outline sidebar), PDF page CSS
 * with header/footer variables, per-document YAML overrides, named presets, and
 * pandoc flag defaults. Pure functions here are unit-tested; the side-effecting
 * orchestration lives in commands.ts.
 */

export type ExportFormat =
  | "html" | "html_plain" | "pdf"
  | "docx" | "odt" | "rtf" | "epub" | "latex" | "mediawiki" | "rst" | "textile" | "opml";

export type AfterExport = "none" | "reveal" | "open" | "run";

export interface ExportPreset {
  name: string;
  format: ExportFormat;
  /** Fixed output path; supports ${dir}, ${name}, ${ext}. Empty → prompt. */
  outputPath?: string;
  after?: AfterExport;
  /** Shell command for `after: "run"`; supports ${output}. */
  command?: string;
  /** Extra pandoc flags (merged after the format defaults). */
  pandocFlags?: string[];
}

export interface PdfOptions {
  pageSize: string; // A4 | Letter | Legal | A3 …
  margin: string; // CSS margin shorthand, e.g. "20mm" or "20mm 18mm"
  header?: string; // template: ${pageNo} ${totalPages} ${title} ${date}
  footer?: string;
}

import { slugify } from "./slug";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const escapeCss = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/* ---------- heading anchors + outline ---------- */

export interface OutlineEntry {
  level: number;
  text: string;
  id: string;
}

/**
 * Add `id` attributes to the headings in rendered HTML and return the matching
 * outline, so the exported TOC links resolve.
 */
export function addHeadingIds(html: string): { html: string; outline: OutlineEntry[] } {
  const seen = new Set<string>();
  const outline: OutlineEntry[] = [];
  const decode = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  const out = html.replace(/<h([1-6])(\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (_, lvl, attrs, inner) => {
    const text = decode(inner.replace(/<[^>]+>/g, "")).trim();
    const id = slugify(text, seen);
    // The live renderer already stamps a (non-deduped) id; drop it and assign a
    // freshly deduped one so the standalone document's anchors stay unique.
    const cleanAttrs = (attrs || "").replace(/\s+id\s*=\s*"[^"]*"/i, "");
    outline.push({ level: Number(lvl), text, id });
    return `<h${lvl}${cleanAttrs} id="${id}">${inner}</h${lvl}>`;
  });
  return { html: out, outline };
}

/* ---------- PDF page CSS ---------- */

/**
 * A @page margin-box `content` value: ${title}/${date} become literals,
 * ${pageNo}/${totalPages} become CSS page counters.
 */
export function headerFooterContent(template: string, ctx: { title: string; date: string }): string {
  const parts: string[] = [];
  const lit = (s: string) => { if (s) parts.push(`"${escapeCss(s)}"`); };
  const re = /\$\{(pageNo|totalPages|title|date)\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(template))) {
    lit(template.slice(last, m.index));
    if (m[1] === "pageNo") parts.push("counter(page)");
    else if (m[1] === "totalPages") parts.push("counter(pages)");
    else lit(m[1] === "title" ? ctx.title : ctx.date);
    last = m.index + m[0].length;
  }
  lit(template.slice(last));
  return parts.length ? parts.join(" ") : '""';
}

const isZeroMargin = (m: string) => /^0(mm|cm|in|px|pt)?$/.test(m.trim());

/**
 * Two page modes:
 *  - margin 0 → full-bleed: the theme background reaches every paper edge. The
 *    @page margin area is paper-white on WebKit and can't be coloured, so the
 *    @page margin stays 0 and the text is inset with body padding. Downside:
 *    body padding only applies at the document start/end, so there's no
 *    breathing room at page breaks.
 *  - margin >0 → framed: a real @page margin, which applies to EVERY page, so
 *    content gets space at every page break (and the margin area can hold an
 *    @page header/footer). The margin area shows paper-white on WebKit.
 * The default margin is non-zero, so exports get page-break spacing out of the
 * box; set margin to 0 for edge-to-edge full-bleed.
 */
export function pageCss(opts: PdfOptions): string {
  // Keep @page margin 0 so the theme background is full-bleed (WebKit won't
  // colour a @page margin). The inset lives on .rendered as padding, and
  // box-decoration-break: clone repeats that padding on EVERY page fragment —
  // so there's breathing room at every page break, and because the padding is
  // transparent the full-bleed background shows through it. Full-bleed + spacing.
  const pad = isZeroMargin(opts.margin) ? "18mm 16mm" : opts.margin.trim();
  return `@page { size: ${opts.pageSize}; margin: 0; } .rendered { padding: ${pad}; box-sizing: border-box; -webkit-box-decoration-break: clone; box-decoration-break: clone; }`;
}

/* ---------- HTML document assembly ---------- */

const TOC_CSS = `
body.has-toc { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 32px; max-width: 1100px; margin: 0 auto; }
body.has-toc .doc-toc { position: sticky; top: 24px; align-self: start; font: 13px/1.6 var(--font-ui, sans-serif); padding-top: 8px; }
body.has-toc .doc-toc .doc-toc-title { font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em; font-size: 11px; color: #888; margin-bottom: 8px; }
body.has-toc .doc-toc ul { list-style: none; margin: 0; padding: 0; }
body.has-toc .doc-toc li { margin: 2px 0; }
body.has-toc .doc-toc li.toc-l2 { padding-left: 12px; }
body.has-toc .doc-toc li.toc-l3 { padding-left: 24px; }
body.has-toc .doc-toc li.toc-l4 { padding-left: 36px; }
body.has-toc .doc-toc a { color: inherit; text-decoration: none; }
body.has-toc .doc-toc a:hover { text-decoration: underline; }
@media print { body.has-toc { display: block; } body.has-toc .doc-toc { display: none; } }
`;

/**
 * Appended after the app stylesheet for exports: force backgrounds/colors to
 * print (Chrome drops them otherwise), give the document a centered column
 * (there's no .page wrapper in the export), and resolve the body theme colors.
 */
// Page-break rules for paginated output (PDF + printed HTML). Uses both the
// legacy page-break-* (best WKWebView support) and modern break-* properties so
// a list item, paragraph, image or table isn't sliced across a page boundary,
// and a heading is never stranded at the foot of a page away from its content.
const PAGE_BREAK_CSS = `
/* Let tall blocks (code, quotes, long paragraphs/lists, big tables) flow across
   pages so they don't leave a big empty gap when they don't fit the remaining
   space; orphans/widows keep those cuts from stranding a single line. */
.rendered p, .rendered li, .rendered blockquote, .rendered pre { orphans: 2; widows: 2; }
/* Keep only bounded elements whole — they either fit or move as a unit. */
.rendered img, .rendered figure, .rendered tr, .rendered .mermaid-block, .rendered .math-block {
  page-break-inside: avoid; break-inside: avoid;
}
/* A heading is never stranded at the foot of a page away from its content. */
.rendered h1, .rendered h2, .rendered h3, .rendered h4, .rendered h5, .rendered h6 {
  page-break-inside: avoid; break-inside: avoid;
  page-break-after: avoid; break-after: avoid;
}
`;

export const EXPORT_PRINT_CSS = `
html, body { height: auto !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { background: var(--bg); color: var(--ink); margin: 0; }
body:not(.has-toc) .rendered { max-width: 760px; margin: 40px auto; padding: 0 28px; }
body.has-toc { padding: 40px 28px; box-sizing: border-box; }
.rendered { padding: 0; }
${PAGE_BREAK_CSS}`;

/**
 * PDF-specific overrides: keep the editor's theme colors (dark stays dark), but
 * let the content fill the printable area (the @page margin is the only inset —
 * no extra column) and avoid awkward page breaks. print-color-adjust forces the
 * theme background/colors to actually print.
 */
export const PDF_PRINT_CSS = `
html, body { height: auto !important; margin: 0 !important; -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
/* Background on html too: the root background is propagated to the page canvas
   so the theme colour fills the @page margins (full-bleed at page breaks). */
html { background: var(--bg); }
body { background: var(--bg); color: var(--ink); }
.rendered { max-width: none !important; width: 100% !important; margin: 0 !important; font-size: 11pt; }
${PAGE_BREAK_CSS}`;

export interface BuildHtmlOptions {
  title: string;
  body: string; // rendered HTML
  css: string; // base export stylesheet
  theme: string;
  withOutline: boolean;
  tablesFull?: boolean; // stretch tables to the column (matches the editor toggle)
  pageCss?: string; // PDF @page rules
}

/** Assemble a standalone HTML document; adds heading ids + an outline sidebar. */
export function buildExportHtml(o: BuildHtmlOptions): string {
  const { html: body, outline } = addHeadingIds(o.body);
  const showToc = o.withOutline && outline.length > 1;
  const toc = showToc
    ? `<nav class="doc-toc"><div class="doc-toc-title">Contents</div><ul>${outline
        .map((h) => `<li class="toc-l${h.level}"><a href="#${h.id}">${escapeHtml(h.text)}</a></li>`)
        .join("")}</ul></nav>`
    : "";
  const bodyClass = [showToc && "has-toc", o.tablesFull && "tables-full"].filter(Boolean).join(" ");
  const style = `<style>${o.css}${showToc ? TOC_CSS : ""}${o.pageCss ?? ""}</style>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(o.title)}</title>${style}</head><body data-theme="${o.theme}" class="${bodyClass}">${toc}<article class="rendered">${body}</article></body></html>`;
}

/* ---------- per-document YAML export overrides ---------- */

export interface ExportOverrides {
  filename?: string;
  pdfMargin?: string;
  pdfPageSize?: string;
  pdfHeader?: string;
  pdfFooter?: string;
}

/** Read export_* keys from parsed front matter. */
export function readExportOverrides(fm: Record<string, string>): ExportOverrides {
  const o: ExportOverrides = {};
  if (fm["export_filename"]) o.filename = fm["export_filename"];
  if (fm["export_pdf_margin"]) o.pdfMargin = fm["export_pdf_margin"];
  if (fm["export_pdf_page_size"]) o.pdfPageSize = fm["export_pdf_page_size"];
  if (fm["export_pdf_header"]) o.pdfHeader = fm["export_pdf_header"];
  if (fm["export_pdf_footer"]) o.pdfFooter = fm["export_pdf_footer"];
  return o;
}

/* ---------- pandoc flags ---------- */

/** Default pandoc flags per format (docx reference doc, epub toc/title, etc.). */
export function pandocFlagsFor(format: string, refDoc?: string): string[] {
  const flags: string[] = [];
  if (format === "docx" || format === "odt") {
    flags.push("--standalone");
    if (refDoc) flags.push(`--reference-doc=${refDoc}`);
  } else if (format === "epub") {
    flags.push("--standalone", "--toc", "--epub-chapter-level=2", "--split-level=2");
  } else if (format === "latex") {
    flags.push("--standalone", "--toc");
  }
  return flags;
}

/* ---------- presets ---------- */

/** Expand an output-path template against the document path parts. */
export function resolveOutputPath(
  template: string,
  parts: { dir: string; name: string; ext: string },
): string {
  return template
    .replace(/\$\{dir\}/g, parts.dir)
    .replace(/\$\{name\}/g, parts.name)
    .replace(/\$\{ext\}/g, parts.ext);
}
