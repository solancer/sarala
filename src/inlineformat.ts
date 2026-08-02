/**
 * Inline-mark analysis over raw Markdown source.
 *
 * The selection toolbar has to answer two questions a document-model editor
 * gets for free: "is the selection bold right now?" and "what source edit
 * toggles that?". Sarala's blocks are their own markdown, so both are
 * answered by scanning the source for marker pairs.
 *
 * The matcher order deliberately mirrors `livesource.ts`'s `inline()` — the
 * toolbar's active states must agree with what the live-styled block actually
 * shows. If one gains a construct, the other has to as well.
 */

export type MarkKind =
  | "strong"
  | "emphasis"
  | "underline"
  | "code"
  | "strike"
  | "highlight"
  | "sub"
  | "sup"
  | "link"
  | "math"
  /** Scanned so its URL isn't mistaken for emphasis; never toggled. */
  | "image";

export interface MarkSpan {
  kind: MarkKind;
  /** First character of the opening marker. */
  start: number;
  /** One past the last character of the closing marker. */
  end: number;
  /** Content between the markers. */
  innerStart: number;
  innerEnd: number;
}

interface Matcher {
  kind: MarkKind;
  re: RegExp;
  /** [opening marker length, closing marker length] for one match. */
  edges: (m: RegExpExecArray) => [number, number];
  /** Literal-content constructs — nothing inside them is markup. */
  opaque?: boolean;
}

const MATCHERS: Matcher[] = [
  { kind: "code", re: /`([^`\n]+)`/g, edges: () => [1, 1], opaque: true },
  {
    kind: "image",
    re: /!\[([^\]\n]*)\]\(([^)\n]*)\)/g,
    edges: (m) => [2, m[0].length - 2 - m[1].length],
    opaque: true,
  },
  { kind: "math", re: /\$(?=\S)([^$\n]*?\S)\$/g, edges: () => [1, 1], opaque: true },
  {
    kind: "link",
    re: /\[([^\]\n]+)\]\(([^)\n]*)\)/g,
    edges: (m) => [1, m[0].length - 1 - m[1].length],
  },
  { kind: "underline", re: /<u>([\s\S]*?)<\/u>/g, edges: () => [3, 4] },
  {
    kind: "strong",
    re: /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,
    edges: (m) => [m[1].length, m[1].length],
  },
  { kind: "emphasis", re: /(\*|_)(?=\S)([^*_\n]*?\S)\1/g, edges: () => [1, 1] },
  { kind: "strike", re: /~~(?=\S)([\s\S]*?\S)~~/g, edges: () => [2, 2] },
  { kind: "highlight", re: /==(?=\S)([\s\S]*?\S)==/g, edges: () => [2, 2] },
  { kind: "sub", re: /~(?![~\s])([^~\n]+?)~(?!~)/g, edges: () => [1, 1] },
  { kind: "sup", re: /\^(?!\s)([^^\s]+?)\^/g, edges: () => [1, 1] },
];

/** Markers each kind wraps with when turned on. */
const WRAP: Record<Exclude<MarkKind, "image">, [string, string]> = {
  strong: ["**", "**"],
  emphasis: ["*", "*"],
  underline: ["<u>", "</u>"],
  code: ["`", "`"],
  strike: ["~~", "~~"],
  highlight: ["==", "=="],
  sub: ["~", "~"],
  sup: ["^", "^"],
  math: ["$", "$"],
  link: ["[", "](url)"],
};

/**
 * Collect the marker pairs in one region. Higher-priority matchers claim their
 * whole span first, so the `*` inside `**bold**` can't be read as emphasis;
 * non-opaque spans then recurse into their content, which is what makes
 * `**bold *and italic***` report both.
 */
function scanRegion(text: string, base: number, out: MarkSpan[]) {
  const claimed = new Uint8Array(text.length);
  for (const matcher of MATCHERS) {
    matcher.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = matcher.re.exec(text)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (end === start) {
        matcher.re.lastIndex++;
        continue;
      }
      let taken = false;
      for (let i = start; i < end; i++) {
        if (claimed[i]) { taken = true; break; }
      }
      if (taken) continue;
      claimed.fill(1, start, end);
      const [openLen, closeLen] = matcher.edges(m);
      const innerStart = start + openLen;
      const innerEnd = end - closeLen;
      out.push({
        kind: matcher.kind,
        start: base + start,
        end: base + end,
        innerStart: base + innerStart,
        innerEnd: base + innerEnd,
      });
      if (!matcher.opaque && innerEnd > innerStart) {
        scanRegion(text.slice(innerStart, innerEnd), base + innerStart, out);
      }
    }
  }
}

/**
 * Every inline marker pair in a block, with source offsets. Scanned per line
 * (and skipping fenced code) because that is exactly the granularity
 * `livesource` styles at — a `*` on one line never pairs with one on the next.
 */
export function scanMarks(text: string): MarkSpan[] {
  const out: MarkSpan[] = [];
  let pos = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
    else if (!inFence) scanRegion(line, pos, out);
    pos += line.length + 1;
  }
  return out;
}

/** Kinds whose content fully contains [start, end) — what the toolbar lights up. */
export function activeMarks(text: string, start: number, end: number): Set<MarkKind> {
  const active = new Set<MarkKind>();
  for (const span of scanMarks(text)) {
    if (span.innerStart <= start && end <= span.innerEnd) active.add(span.kind);
  }
  return active;
}

export interface MarkEdit {
  text: string;
  /** Selection to restore, so the toolbar stays anchored after a toggle. */
  start: number;
  end: number;
}

/**
 * Turn a mark on (wrap the selection) or off (drop the innermost enclosing
 * marker pair), returning the new source plus the selection that still covers
 * the same words.
 */
export function toggleMark(
  text: string,
  start: number,
  end: number,
  kind: Exclude<MarkKind, "image">,
): MarkEdit {
  const enclosing = scanMarks(text).filter(
    (s) => s.kind === kind && s.innerStart <= start && end <= s.innerEnd,
  );
  if (enclosing.length) {
    // Innermost wins: unbolding inside `**a *b* c**` should not also strip the
    // emphasis, and nested same-kind pairs peel one layer at a time.
    const span = enclosing.reduce((a, b) =>
      b.innerEnd - b.innerStart < a.innerEnd - a.innerStart ? b : a,
    );
    const openLen = span.innerStart - span.start;
    return {
      text:
        text.slice(0, span.start) +
        text.slice(span.innerStart, span.innerEnd) +
        text.slice(span.end),
      start: start - openLen,
      end: end - openLen,
    };
  }

  const [open, close] = WRAP[kind];
  const body = text.slice(start, end);
  const next = text.slice(0, start) + open + body + close + text.slice(end);
  if (kind === "link") {
    // Leave the `url` placeholder selected so typing replaces it outright.
    const urlStart = start + open.length + body.length + "](".length;
    return { text: next, start: urlStart, end: urlStart + "url".length };
  }
  return { text: next, start: start + open.length, end: end + open.length };
}
