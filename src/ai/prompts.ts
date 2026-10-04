/**
 * Prompt text sent to the agent CLI each turn. The agent works on a working
 * copy, document.md, in its current directory; every change it makes there
 * comes back to the user as a proposal to accept or reject.
 */

export interface TurnContext {
  /** Display name of the user's file. */
  name: string;
  /** False on the first turn of a session. */
  resumed: boolean;
  /** Accept/reject outcomes since the previous turn. */
  decisions: string[];
  /** Serialized <selection> references, if any. */
  selection: string;
  request: string;
}

export function turnPrompt(c: TurnContext): string {
  const parts = [
    `You are the writing assistant inside Sarala, a Markdown editor. The user's document "${c.name}" is in ./document.md, a working copy.`,
    [
      "- To change the document, edit document.md directly. Do not create, rename, or delete any other file.",
      "- The user reviews each change you make as a diff and accepts or rejects it, so change only what the request calls for.",
      "- Preserve the document's Markdown conventions (heading style, list markers, emphasis characters, line wrapping) and its voice. Leave front matter, code blocks, math, and diagram blocks alone unless asked.",
      "- If the user only asks a question, answer it without editing the file.",
      "- Keep your reply short: say in a sentence or two what you changed, or answer the question.",
    ].join("\n"),
  ];
  if (c.resumed) {
    parts.push("document.md now holds the user's current version, which may differ from what you last saw. Read it again before editing.");
  }
  if (c.decisions.length) parts.push(`Since your last reply: ${c.decisions.join("; ")}.`);
  if (c.selection) parts.push(`The user selected this part of the document:\n${c.selection}`);
  parts.push(`Request: ${c.request}`);
  return parts.join("\n\n");
}

export type QuickAction = "improve" | "shorten" | "fix" | "explain";

export const QUICK_ACTIONS: { id: QuickAction; label: string }[] = [
  { id: "improve", label: "Improve writing" },
  { id: "shorten", label: "Make shorter" },
  { id: "fix", label: "Fix spelling & grammar" },
  { id: "explain", label: "Explain" },
];

export function quickActionPrompt(action: QuickAction): string {
  switch (action) {
    case "improve":
      return "Improve the clarity and flow of the selected text in document.md. Keep its meaning, tone, and Markdown formatting.";
    case "shorten":
      return "Make the selected text in document.md more concise without losing meaning.";
    case "fix":
      return "Fix spelling, grammar, and punctuation in the selected text in document.md. Change nothing else. If there is nothing to fix, say so.";
    case "explain":
      return "Explain the selected text briefly. Do not edit the file.";
  }
}

export const REVIEW_PROMPT =
  "Review the whole document without editing the file. Reply with the most important issues (clarity, correctness, " +
  "structure, consistency, missing information), most important first, each saying where it is. At most about a dozen. " +
  "End with a two or three sentence overall assessment.";
