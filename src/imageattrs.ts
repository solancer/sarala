/**
 * `<img>` attribute schema, parsing, and serialisation.
 *
 * CommonMark's `![alt](src)` carries exactly two properties, so anything more
 * (width, loading, srcset …) has to be written as a raw HTML `<img>` tag.
 * Sarala already made that trade — `setImageZoom` has forced HTML syntax since
 * before this module existed — so the properties panel follows the same rule:
 * an image stays `![alt](src)` until a property that markdown cannot express is
 * set, then it is promoted to `<img>` and stays there.
 *
 * Promotion is one-way on purpose. Clearing the last extra attribute does not
 * silently rewrite the tag back to markdown syntax, because the user may have
 * chosen HTML deliberately (Image ▸ Syntax ▸ HTML).
 */

export type ImgFieldKind = "text" | "number" | "enum";

export interface ImgField {
  name: string;
  label: string;
  kind: ImgFieldKind;
  /** For `enum` fields; the empty string means "not set". */
  options?: readonly string[];
  placeholder?: string;
  /** Hidden behind the panel's Advanced disclosure. */
  advanced?: boolean;
}

/**
 * The panel's fields, in display order — also the attribute order used when a
 * tag is rewritten, so editing an image produces a stable, diff-friendly tag
 * rather than reshuffling its attributes.
 */
export const IMG_FIELDS: readonly ImgField[] = [
  { name: "src", label: "Src", kind: "text", placeholder: "Image URL or path" },
  { name: "alt", label: "Alt", kind: "text", placeholder: "Describe this image" },
  { name: "width", label: "Width", kind: "number", advanced: true },
  { name: "height", label: "Height", kind: "number", advanced: true },
  { name: "title", label: "Title", kind: "text", advanced: true },
  { name: "srcset", label: "Srcset", kind: "text", placeholder: "img-2x.png 2x", advanced: true },
  { name: "sizes", label: "Sizes", kind: "text", placeholder: "(max-width: 600px) 100vw", advanced: true },
  { name: "loading", label: "Loading", kind: "enum", options: ["", "lazy", "eager"], advanced: true },
  { name: "decoding", label: "Decoding", kind: "enum", options: ["", "sync", "async", "auto"], advanced: true },
  { name: "fetchpriority", label: "Fetch priority", kind: "enum", options: ["", "high", "low", "auto"], advanced: true },
  { name: "crossorigin", label: "Crossorigin", kind: "enum", options: ["", "anonymous", "use-credentials"], advanced: true },
  {
    name: "referrerpolicy",
    label: "Referrer policy",
    kind: "enum",
    options: ["", "no-referrer", "no-referrer-when-downgrade", "origin", "same-origin", "strict-origin-when-cross-origin", "unsafe-url"],
    advanced: true,
  },
];

/** Attributes the markdown form carries natively; everything else forces HTML. */
const CORE = new Set(["src", "alt"]);

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Every attribute on an `<img>` tag, lowercased. Unrecognised ones are kept so
 * a rewrite never discards markup the panel does not know about (a `class`, a
 * `data-*` hook, the `style` that `setImageZoom` writes).
 */
export function parseImgAttrs(tag: string): Record<string, string> {
  const body = tag.replace(/^\s*<img/i, "").replace(/\/?>\s*$/, "");
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`=]+)))?/g;
  const out: Record<string, string> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

/** Serialise an attribute map back to a tag. `src`/`alt` are always emitted. */
export function buildImgTag(attrs: Record<string, string>): string {
  const parts: string[] = [];
  const known = new Set<string>();
  for (const f of IMG_FIELDS) {
    known.add(f.name);
    const v = attrs[f.name] ?? "";
    if (CORE.has(f.name) || v !== "") parts.push(`${f.name}="${escapeAttr(v)}"`);
  }
  // Preserve anything outside the schema, in its original order.
  for (const [k, v] of Object.entries(attrs)) {
    if (known.has(k)) continue;
    parts.push(v === "" ? k : `${k}="${escapeAttr(v)}"`);
  }
  return `<img ${parts.join(" ")} />`;
}

/** True when any attribute beyond `src`/`alt` is set — i.e. markdown won't do. */
export function needsHtmlSyntax(attrs: Record<string, string>): boolean {
  return Object.entries(attrs).some(([k, v]) => !CORE.has(k) && v !== "");
}

/**
 * Render an image occurrence. Falls back to `![alt](src)` only when the syntax
 * is markdown *and* nothing beyond src/alt is set; otherwise emits a tag.
 */
export function imageMarkup(
  src: string,
  alt: string,
  kind: "md" | "html",
  attrs: Record<string, string> = {},
): string {
  const extras = { ...attrs };
  delete extras.src;
  delete extras.alt;
  if (kind === "md" && !needsHtmlSyntax(extras)) return `![${alt}](${src})`;
  return buildImgTag({ ...extras, src, alt });
}
