/**
 * Slash-menu catalogue, ranking, and trigger detection — all pure.
 *
 * Everything offered here is deliberately plain Markdown. Slash menus in MDX
 * editors lean on JSX components (callouts, accordions, tabs) that have no
 * CommonMark spelling, so this list is built only from constructs that survive
 * a round trip through a `.md` file — GitHub alerts stand in for callouts, and
 * fenced `mermaid` / `d2` blocks for diagrams.
 *
 * The items carry no behaviour: actions live in `slashactions.ts`, keyed by id,
 * so this module stays free of the command layer (and its Tauri imports) and
 * can be unit-tested on its own. `SlashItemId` is derived from this array, so
 * an item without an action fails the typecheck.
 */

export interface SlashItem {
  id: string;
  label: string;
  /** Section heading in the menu. */
  group: string;
  /** Key into `menuicons.ICONS`. */
  icon: string;
  /** Extra search terms — `h1` finds "Heading 1", `todo` finds "Task List". */
  aliases?: readonly string[];
  /** Right-aligned markdown hint, e.g. `# `. */
  hint?: string;
}

export const SLASH_ITEMS = [
  // ---- Basic: convert the current block ----
  { id: "text", label: "Text", group: "Basic", icon: "paragraph", aliases: ["paragraph", "plain", "body"] },
  { id: "h1", label: "Heading 1", group: "Basic", icon: "h1", aliases: ["h1", "title"], hint: "# " },
  { id: "h2", label: "Heading 2", group: "Basic", icon: "h2", aliases: ["h2"], hint: "## " },
  { id: "h3", label: "Heading 3", group: "Basic", icon: "h3", aliases: ["h3"], hint: "### " },
  { id: "ul", label: "Bullet List", group: "Basic", icon: "list", aliases: ["ul", "unordered", "bullet"], hint: "- " },
  { id: "ol", label: "Ordered List", group: "Basic", icon: "listOrdered", aliases: ["ol", "numbered", "number"], hint: "1. " },
  { id: "task", label: "Task List", group: "Basic", icon: "listTask", aliases: ["todo", "checklist", "checkbox"], hint: "- [ ] " },
  { id: "quote", label: "Quote", group: "Basic", icon: "quote", aliases: ["blockquote"], hint: "> " },
  { id: "code", label: "Code Block", group: "Basic", icon: "codeBlock", aliases: ["fence", "pre", "snippet"], hint: "```" },

  // ---- Insert ----
  { id: "table", label: "Table", group: "Insert", icon: "table", aliases: ["grid"] },
  { id: "image", label: "Image", group: "Insert", icon: "image", aliases: ["picture", "photo", "img"] },
  { id: "link", label: "Link", group: "Insert", icon: "link", aliases: ["url", "href", "hyperlink"] },
  { id: "divider", label: "Divider", group: "Insert", icon: "hr", aliases: ["hr", "rule", "separator", "line"], hint: "---" },
  { id: "math", label: "Math Block", group: "Insert", icon: "math", aliases: ["latex", "equation", "formula", "katex"], hint: "$$" },
  { id: "footnote", label: "Footnote", group: "Insert", icon: "footnote", aliases: ["fn", "ref", "reference"] },
  { id: "toc", label: "Table of Contents", group: "Insert", icon: "toc", aliases: ["outline", "contents"] },
  { id: "frontmatter", label: "YAML Front Matter", group: "Insert", icon: "frontMatter", aliases: ["yaml", "meta", "metadata"] },

  // ---- Diagram: fenced blocks Sarala renders live ----
  { id: "mermaid", label: "Mermaid Diagram", group: "Diagram", icon: "diagram", aliases: ["flowchart", "sequence", "graph", "chart"] },
  { id: "d2", label: "D2 Diagram", group: "Diagram", icon: "diagram", aliases: ["graph", "architecture"] },

  // ---- Callout: GitHub alerts, the CommonMark-compatible stand-in ----
  { id: "note", label: "Note", group: "Callout", icon: "alert", aliases: ["callout", "info", "admonition"] },
  { id: "tip", label: "Tip", group: "Callout", icon: "alert", aliases: ["callout", "hint", "admonition"] },
  { id: "important", label: "Important", group: "Callout", icon: "alert", aliases: ["callout", "admonition"] },
  { id: "warning", label: "Warning", group: "Callout", icon: "alert", aliases: ["callout", "admonition"] },
  { id: "caution", label: "Caution", group: "Callout", icon: "alert", aliases: ["callout", "danger", "admonition"] },
] as const satisfies readonly SlashItem[];

export type SlashItemId = (typeof SLASH_ITEMS)[number]["id"];

/**
 * Rank items against a `/` query. Prefix matches on the label sort above
 * word-start matches, which sort above alias-only hits, so `/co` leads with
 * "Code Block" rather than a callout that merely lists `callout` as an alias.
 * An empty query keeps the catalogue's own (grouped) order.
 */
export function filterSlashItems(
  query: string,
  items: readonly SlashItem[] = SLASH_ITEMS,
): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const scored: { item: SlashItem; rank: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    let rank = -1;
    if (label.startsWith(q)) rank = 0;
    else if (label.split(/\s+/).some((w) => w.startsWith(q))) rank = 1;
    else if (item.aliases?.some((a) => a.toLowerCase().startsWith(q))) rank = 2;
    else if (label.includes(q)) rank = 3;
    else if (item.aliases?.some((a) => a.toLowerCase().includes(q))) rank = 4;
    if (rank >= 0) scored.push({ item, rank, index });
  });
  scored.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return scored.map((s) => s.item);
}

export interface SlashTrigger {
  /** Offset of the `/` itself. */
  start: number;
  /** Text between the `/` and the caret. */
  query: string;
}

/**
 * The active `/query` token ending at `caret`, or null.
 *
 * A slash only triggers at the start of a line or after whitespace, so file
 * paths (`src/foo`), URLs, and closing tags never open the menu. The query
 * stops at whitespace — typing a space dismisses rather than searching on.
 */
export function slashTriggerAt(text: string, caret: number): SlashTrigger | null {
  const upto = text.slice(0, Math.max(0, Math.min(caret, text.length)));
  const m = upto.match(/(?:^|[\s>])\/([^\s/]*)$/);
  if (!m) return null;
  return { start: upto.length - m[1].length - 1, query: m[1] };
}
