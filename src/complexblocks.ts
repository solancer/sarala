/** Blocks whose source needs a separate editor so activation cannot replace their preview. */
export function complexBlockKind(source: string, options: { mathFence?: boolean; alternateMath?: boolean } = {}): string | null {
  const text = source.trim();
  const language = /^(`{3,}|~{3,})[ \t]*(\w+)/.exec(text)?.[2].toLowerCase();
  if (language && ["mermaid","d2","sequence","flow"].includes(language)) return "Diagram";
  if (language === "math" && options.mathFence || text.startsWith("$$") || options.alternateMath && text.startsWith("\\[")) return "Equation";
  if (/^---\n[\s\S]*\n---$/.test(text)) return "Metadata";
  if (/^\[\^[^\]\s]+\]:/.test(text)) return "Footnote";
  if (/^(?:\[toc\]|\[\[_toc_\]\])$/i.test(text)) return "Table of contents";
  if (/^<(?:details|summary|video|audio|iframe|table|div|section|article|figure)\b/i.test(text)) return "HTML";
  return null;
}
