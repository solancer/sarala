import { Marked } from "marked";
import { markedHighlight } from "marked-highlight";
import hljs from "highlight.js/lib/common";
import DOMPurify from "dompurify";

const marked = new Marked(
  markedHighlight({
    emptyLangClass: "hljs",
    langPrefix: "hljs language-",
    highlight(code, lang) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  })
);
marked.setOptions({ gfm: true, breaks: false });

/** Edit ▸ Whitespace: render single newlines as <br> when enabled. */
export function setPreserveBreaksOption(on: boolean) {
  marked.setOptions({ breaks: on });
}

/** Render a markdown string to sanitized HTML. */
export function renderMarkdown(md: string): string {
  if (!md.trim()) return `<p class="empty-block">&nbsp;</p>`;
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw, { ADD_ATTR: ["target"] });
}

/**
 * Split a markdown document into editable blocks.
 * Blocks are separated by blank lines, but fenced code blocks and
 * leading YAML front matter are kept intact as single blocks.
 */
export function splitBlocks(md: string): string[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let buf: string[] = [];
  let inFence = false;
  let fenceMark = "";
  let i = 0;

  // YAML front matter
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === "---");
    if (end > 0) {
      blocks.push(lines.slice(0, end + 1).join("\n"));
      i = end + 1;
      while (i < lines.length && lines[i].trim() === "") i++;
    }
  }

  const flush = () => {
    if (buf.length) blocks.push(buf.join("\n"));
    buf = [];
  };

  for (; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^(\s*)(`{3,}|~{3,})/);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMark = fence[2][0];
      } else if (fence[2][0] === fenceMark) {
        inFence = false;
      }
      buf.push(line);
      continue;
    }
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks.length ? blocks : [""];
}

/** Detect whether a block's text still contains an unterminated fence. */
export function hasOpenFence(text: string): boolean {
  let open = false;
  let mark = "";
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(`{3,}|~{3,})/);
    if (!m) continue;
    if (!open) {
      open = true;
      mark = m[1][0];
    } else if (m[1][0] === mark) {
      open = false;
    }
  }
  return open;
}

export function joinBlocks(blocks: string[]): string {
  return blocks.join("\n\n") + "\n";
}

export interface Heading {
  level: number;
  text: string;
  blockIndex: number;
}

export function extractOutline(blocks: string[]): Heading[] {
  const out: Heading[] = [];
  blocks.forEach((b, blockIndex) => {
    if (hasOpenFence(b)) return;
    let inFence = false;
    for (const line of b.split("\n")) {
      if (/^\s*(`{3,}|~{3,})/.test(line)) inFence = !inFence;
      if (inFence) continue;
      const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (m) out.push({ level: m[1].length, text: m[2], blockIndex });
    }
  });
  return out;
}

export function countWords(md: string): { words: number; chars: number } {
  const stripped = md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[#>*_`~\-\[\]()!|]/g, " ")
    .trim();
  const words = stripped ? stripped.split(/\s+/).length : 0;
  return { words, chars: md.length };
}

/** Toggle the nth task-list checkbox inside a block's source. */
export function toggleTask(text: string, nth: number): string {
  let seen = -1;
  return text.replace(/\[( |x|X)\]/g, (m, state) => {
    seen++;
    if (seen !== nth) return m;
    return state === " " ? "[x]" : "[ ]";
  });
}
