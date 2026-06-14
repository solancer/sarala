/**
 * Rich-paste support: convert HTML clipboard content (Google Docs, Apple Notes,
 * web pages) into Markdown, and scrub control characters from any pasted text.
 */
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

/**
 * Drop non-printable control characters that would otherwise corrupt the
 * source text — caret offsets are measured in code units, and stray NULs /
 * vertical-tabs / DELs render as invisible junk. Tabs and newlines are kept;
 * CR / CRLF are normalized to LF (the editor stores LF internally).
 */
export function stripControlChars(s: string): string {
  return (
    s
      .replace(/\r\n?/g, "\n")
      // C0 controls except \t (\x09) and \n (\x0A), plus DEL (\x7F).
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
      // BOM / zero-width no-break space.
      .replace(/﻿/g, "")
  );
}

let service: TurndownService | null = null;

function getService(): TurndownService {
  if (service) return service;
  const s = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
    strongDelimiter: "**",
    linkStyle: "inlined",
  });
  s.use(gfm); // tables, strikethrough, task lists
  // The gfm plugin emits single-tilde ~strike~, which is wrong for GFM and
  // collides with our subscript syntax — force the ~~double~~ form.
  s.addRule("strikethrough", {
    filter: (node) => node.nodeName === "DEL" || node.nodeName === "S" || node.nodeName === "STRIKE",
    replacement: (content) => `~~${content}~~`,
  });
  // Google Docs wraps the whole selection in <b style="font-weight:normal">;
  // without this it would bold everything. Treat any explicitly-normal-weight
  // bold/strong as plain text.
  s.addRule("normalWeightBold", {
    filter: (node) =>
      (node.nodeName === "B" || node.nodeName === "STRONG") &&
      /font-weight\s*:\s*normal/i.test(node.getAttribute("style") || ""),
    replacement: (content) => content,
  });
  service = s;
  return s;
}

/** Convert pasted HTML to Markdown; returns "" if conversion fails. */
export function htmlToMarkdown(html: string): string {
  try {
    return stripControlChars(getService().turndown(html)).trim();
  } catch {
    return "";
  }
}

/**
 * Decide what text a paste should insert. Inside a code fence or YAML front
 * matter (`inFence`) the content is literal, so the raw plain text is used —
 * never the HTML→Markdown conversion, which would backslash-escape `[ ] - >`
 * and corrupt e.g. a pasted mermaid diagram. Elsewhere, rich HTML is converted
 * to Markdown, falling back to plain text.
 */
export function pasteToInsert(opts: { html: string; plain: string; inFence: boolean }): string {
  if (opts.inFence) return stripControlChars(opts.plain);
  if (opts.html && opts.html.trim()) {
    return htmlToMarkdown(opts.html) || stripControlChars(opts.plain);
  }
  return stripControlChars(opts.plain);
}
