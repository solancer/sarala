import { EMOJI_NAME } from "./emoji";

export interface EmojiTrigger { start: number; end: number; query: string }
/** Completion triggers only at a text boundary, never inside literal code. */
export function emojiTriggerAt(source: string, caret: number): EmojiTrigger | null {
  if (!Number.isInteger(caret) || caret < 0 || caret > source.length) return null;
  const before = source.slice(0,caret);
  const match = new RegExp(`(?:^|[\\s(])(:(${EMOJI_NAME}))$`, "u").exec(before);
  if (!match || match[2].length > 256) return null;
  let fence = "", inline = 0;
  const prefix = before.slice(0, before.length - match[1].length);
  for (const line of prefix.split("\n")) {
    const marker = /^\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = "";
      continue;
    }
    if (fence) continue;
    for (let i = 0; i < line.length;) {
      if (line[i] === "\\") { i += 2; continue; }
      const ticks = /^`+/.exec(line.slice(i));
      if (ticks) { if (!inline) inline = ticks[0].length; else if (inline === ticks[0].length) inline = 0; i += ticks[0].length; }
      else i++;
    }
  }
  if (fence || inline || /(?:^|\n)(?: {4}|\t)[^\n]*$/.test(before)) return null;
  return {start:caret - match[1].length,end:caret,query:match[2]};
}
