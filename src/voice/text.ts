/**
 * Voice typing's pure text and key logic (unit-tested in
 * tests/voice.test.mjs): spoken commands and punctuation, fitting dictated
 * words into the text around the caret, and the shortcut (matching, recording,
 * labels, clashes).
 */

/* ---------- spoken commands ---------- */

/** What a whole utterance asks for, when it is a command rather than text. */
export type VoiceAction =
  | "scratch" | "stop" | "select" | "bold" | "italic" | "heading" | "bullet" | "task" | "help"
  | "table" | "tableRowAdd" | "tableRowAbove" | "tableRowBelow" | "tableRowDelete"
  | "tableColAdd" | "tableColBefore" | "tableColAfter" | "tableColDelete"
  | "tableRowUp" | "tableRowDown" | "tableColLeft" | "tableColRight"
  | "tableAlignLeft" | "tableAlignCenter" | "tableAlignRight"
  | null;

const normalized = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Each command, with the phrases that say it (after normalizing case and
 *  punctuation). They only count as the whole utterance, so a sentence that
 *  merely contains the words is typed as text. */
const ACTIONS: [Exclude<VoiceAction, null>, RegExp][] = [
  // Tolerates what speech models commonly hear instead ("scratched that",
  // "bolt that"; measured with tests/voice-bench.mjs).
  ["scratch", /^(scratch(ed|es)?|delete|undo|remove) (that|this)$/],
  ["stop", /^stop (listening|dictation|dictating|voice typing)$/],
  ["select", /^select (that|this)$/],
  ["bold", /^((bold|bolt|bowled) (that|this)|make (that|this) (bold|bolt))$/],
  ["italic", /^(italici[sz]e (that|this)|italic (that|this)|make (that|this) italic)$/],
  ["heading", /^make (that|this) (a )?(heading|title)$/],
  ["bullet", /^make (that|this) (a )?(bullet( point)?|list( item)?)$/],
  ["task", /^make (that|this) (a )?(task|to ?do|checkbox)$/],
  ["help", /^(what can i say|show (voice )?commands|voice commands)$/],
  // Tables: act on the table at the caret, so each is a no-op off one.
  ["tableRowAdd", /^add (?:a )?row$/],
  ["tableRowAbove", /^(?:add (?:a )?)?row above$/],
  ["tableRowBelow", /^(?:add (?:a )?)?row below$/],
  ["tableRowDelete", /^(?:delete|remove) (?:the |this )?row$/],
  ["tableColAdd", /^add (?:a )?column$/],
  ["tableColBefore", /^(?:add (?:a )?)?column before$/],
  ["tableColAfter", /^(?:add (?:a )?)?column after$/],
  ["tableColDelete", /^(?:delete|remove) (?:the |this )?column$/],
  ["tableRowUp", /^move (?:the |this )?row up$/],
  ["tableRowDown", /^move (?:the |this )?row down$/],
  ["tableColLeft", /^move (?:the |this )?column left$/],
  ["tableColRight", /^move (?:the |this )?column right$/],
  ["tableAlignLeft", /^align(?: (?:the |this )?column)? left$/],
  ["tableAlignCenter", /^align(?: (?:the |this )?column)? cent(?:er|re)$/],
  ["tableAlignRight", /^align(?: (?:the |this )?column)? right$/],
];

const TABLE_NUM = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const TABLE_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const TABLE_RE = new RegExp(`^(?:new|insert|add) table(?:\\s+${TABLE_NUM}\\s*(?:by|x)\\s*${TABLE_NUM})?$`);

/** "New table" (default 3 body rows by 2 columns, matching the dialog's own
 *  default) or "new table <rows> by <columns>", spoken as digits or words. */
export function tableSize(text: string): { rows: number; cols: number } | null {
  const m = normalized(text).match(TABLE_RE);
  if (!m) return null;
  if (!m[1]) return { rows: 3, cols: 2 };
  const n = (w: string) => TABLE_WORDS[w] ?? Number(w);
  return { rows: n(m[1]), cols: n(m[2]) };
}

/** A command said on its own ("scratch that", "bold that", "what can I say"). */
export function voiceAction(text: string): VoiceAction {
  const t = normalized(text);
  if (tableSize(t)) return "table";
  for (const [action, re] of ACTIONS) if (re.test(t)) return action;
  return null;
}

/**
 * A command said as the last sentence of a stretch, without a pause before
 * it: "This is a test. Make that bold." It must start a new sentence, so
 * "I decided to make that bold" stays text.
 */
export function splitTrailingCommand(raw: string): { text: string; action: Exclude<VoiceAction, null> } | null {
  const m = raw.match(/^([\s\S]*[.!?])\s+([^.!?]+[.!?]?)\s*$/);
  if (!m) return null;
  const action = voiceAction(m[2]);
  return action ? { text: m[1], action } : null;
}

/** Placeholders for structure commands, resolved against the text around the
 *  caret by fitDictation (a bullet joins a list it follows). */
const BULLET = "\uE001";
const TASK = "\uE002";
const HEADING = "\uE003";

/** Punctuation spoken as words (the macOS Dictation vocabulary). Opt-in,
 *  because the models punctuate on their own and "period" can be a word. */
const PUNCTUATION: [RegExp, string][] = [
  [/\b(?:period|full stop)\b/gi, "."],
  [/\bcomm?a\b/gi, ","],
  [/\bquestion mark\b/gi, "?"],
  [/\bexclamation (?:mark|point)\b/gi, "!"],
  [/\bsemicolon\b/gi, ";"],
  [/\bcolon\b/gi, ":"],
  [/\bellipsis\b/gi, "…"],
  [/\b(?:open|left) (?:paren|parenthesis|bracket)\b/gi, "("],
  [/\b(?:close|right) (?:paren|parenthesis|bracket)\b/gi, ")"],
  // Closing first: the bare "quote" of the opening rule is inside "close quote".
  [/\b(?:close quote|end quote|unquote)\b/gi, "\u0002"],
  [/\b(?:open quote|begin quote|quote)\b/gi, "\u0001"],
  [/\bhyphen\b/gi, "\u0003"],
];

function spokenPunctuation(text: string): string {
  let t = text;
  for (const [re, mark] of PUNCTUATION) {
    // The model may already have punctuated around the word ("Hello, comma, world.").
    t = t.replace(new RegExp(`[,.;:]?\\s*${re.source}[,.;:]?`, "gi"), mark.length === 1 && /[.,?!;:…)]/.test(mark) ? mark : ` ${mark}`);
  }
  return t
    .replace(/\s*\u0001\s*/g, ' "')
    .replace(/\s*\u0002/g, '"')
    .replace(/\s*\u0003\s*/g, "-")
    .replace(/\(\s+/g, "(")
    .replace(/\s+([.,?!;:…)])/g, "$1")
    .replace(/([.?!…])\s*([\p{Ll}])/gu, (_, p: string, c: string) => `${p} ${c.toUpperCase()}`)
    .replace(/ {2,}/g, " ")
    .trim();
}

/**
 * Turn spoken layout commands into text: "new paragraph" (a blank line, so
 * the block splits), "new line" (a line break), and optionally spoken
 * punctuation.
 */
export function applyVoiceCommands(text: string, opts: { layout?: boolean; punctuation?: boolean } = {}): string {
  let t = opts.punctuation ? spokenPunctuation(text) : text;
  if (opts.layout === false) return t.trim();
  // Structure first: "new bullet point" must not leave "point" behind.
  // The punctuation before a command belongs to the sentence before it. In
  // prose these phrases follow an article or determiner ("add a new task",
  // "the new heading"), which a command never does: those stay text.
  const notProse = "(?<!\\b(?:a|an|the|this|that|another|one|each|every|my|your|our|their|his|her|its)\\s+)";
  const cmd = (words: string) => new RegExp(`[\\s,;]*${notProse}\\b(?:${words})\\b[.,;:!?]*\\s*`, "gi");
  t = t
    .replace(cmd("(?:new|next) (?:bullet(?: point)?|list item)"), BULLET)
    .replace(cmd("new (?:task|to ?do|checkbox)"), TASK)
    .replace(cmd("new (?:heading|title)"), HEADING)
    .replace(cmd("new paragraph"), "\n\n")
    .replace(cmd("new line"), "\n")
    .replace(/(\n\n?|[\uE001-\uE003])([\p{Ll}])/gu, (_, nl: string, c: string) => nl + c.toUpperCase());
  return t.replace(/^\n+|\n+$/g, "");
}

/* ---------- fitting into the text ---------- */

/**
 * The text to insert between `before` and `after`: a space where words would
 * otherwise touch; mid-sentence the model's capital letter lowered ("and The"
 * → "and the", except "I" and acronyms); a new sentence capitalized.
 */
export function fitDictation(before: string, after: string, text: string): string {
  if (/[\uE001-\uE003]/.test(text)) return fitStructure(before, after, text);
  let t = text.trim();
  if (!t) return t;
  const prev = before.trimEnd();
  if (/[\p{Ll},;]$/u.test(prev)) {
    // Mid-sentence.
    t = t.replace(/^(\p{Lu})(\p{Ll})/u, (_, a: string, b: string) => a.toLowerCase() + b);
  } else if (prev === "" || /[.?!…]["”')]?$/.test(prev)) {
    // A new sentence.
    t = t.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  }
  // An opening emphasis marker ("**|**", "the _|") takes no space: "** bold**"
  // would not be bold.
  const opener = /(^|\s)[*_~=`]+$/.test(before);
  // After a line break nothing is needed either.
  if (before && !opener && !/[\s([{"'“‘/-]$/.test(before) && !/^[.,?!;:]/.test(t)) t = ` ${t}`;
  if (after && /^[\p{L}\p{N}([{"“]/u.test(after)) t = `${t} `;
  return t;
}

/* ---------- shortcuts ----------
 *
 * A shortcut id is modifiers then one key, joined by "+": "Ctrl+Alt+Space",
 * "Meta+Shift+D", "F8", "Alt+Backquote". The key is "Space", F1-F24, a letter
 * or digit, or a KeyboardEvent.code for anything else. Physical keys (codes)
 * are used so a shortcut survives Option/AltGr changing the character
 * (Option+D types ∂ on a Mac). */

const MODS = ["Ctrl", "Alt", "Shift", "Meta"] as const;

function keyMatches(e: KeyboardEvent, key: string): boolean {
  if (key === "Space") return e.code === "Space";
  if (/^F\d{1,2}$/.test(key)) return e.key === key || e.code === key;
  if (/^[A-Z]$/.test(key)) return e.code === `Key${key}`;
  if (/^\d$/.test(key)) return e.code === `Digit${key}`;
  return e.code === key;
}

/** Does this keyboard event match a shortcut id like "Ctrl+Alt+Space"? */
export function matchesShortcut(e: KeyboardEvent, id: string): boolean {
  const parts = id.split("+");
  const key = parts.pop()!;
  const want = new Set(parts);
  if (e.altKey !== want.has("Alt") || e.ctrlKey !== want.has("Ctrl") || e.metaKey !== want.has("Meta") || e.shiftKey !== want.has("Shift")) {
    return false;
  }
  return keyMatches(e, key);
}

/** Is this key part of the shortcut (so releasing it ends a hold)? */
export function isShortcutKey(e: KeyboardEvent, id: string): boolean {
  const parts = id.split("+");
  const key = parts.pop()!;
  if (keyMatches(e, key)) return true;
  const mod: Record<string, string> = { Alt: "Alt", Ctrl: "Control", Meta: "Meta", Shift: "Shift" };
  return parts.some((p) => mod[p] === e.key);
}

/** The same shortcut always spelled the same way (modifiers in a fixed order). */
export function canonicalShortcut(id: string): string {
  const parts = id.split("+");
  const key = parts.pop()!;
  return [...MODS.filter((m) => parts.includes(m)), key].join("+");
}

/** Keys a shortcut may never be: they would break typing or navigation. */
const RESERVED = new Set(["Escape", "Tab", "Enter", "NumpadEnter", "Backspace", "Delete", "CapsLock",
  "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"]);

/**
 * The shortcut a key press records, or why it can't be one.
 *
 * WCAG 2.1.4 (Character Key Shortcuts): a printable key needs Ctrl, Alt/Option
 * or Cmd, so typing (or dictating with another tool) can't set it off. Function
 * keys and keys like Insert, Pause or Scroll Lock may stand alone.
 */
export function shortcutFromEvent(e: KeyboardEvent): { id: string } | { error: string } | null {
  if (["Control", "Alt", "Shift", "Meta", "AltGraph", "OS", "Fn"].includes(e.key)) return null; // still holding modifiers
  if (RESERVED.has(e.code)) return { error: `${e.code === "Escape" ? "Esc" : e.code} is needed for editing. Try another key.` };
  let key: string;
  if (e.code === "Space") key = "Space";
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code) || /^F\d{1,2}$/.test(e.key)) key = /^F\d{1,2}$/.test(e.code) ? e.code : e.key;
  else if (e.code) key = e.code;
  else return null;
  const mods = MODS.filter((m) => (m === "Ctrl" ? e.ctrlKey : m === "Alt" ? e.altKey : m === "Shift" ? e.shiftKey : e.metaKey));
  const standalone = /^F\d{1,2}$/.test(key) || ["Insert", "Pause", "ScrollLock", "ContextMenu", "PrintScreen"].includes(key);
  const printable = !standalone;
  if (printable && !mods.some((m) => m !== "Shift")) {
    return { error: "Add Ctrl, Alt (Option) or Cmd, so typing can't start voice typing by accident." };
  }
  return { id: [...mods, key].join("+") };
}

const CODE_LABELS: Record<string, string> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", ScrollLock: "Scroll Lock",
  ContextMenu: "Menu", PrintScreen: "Print Screen",
};

/** Human label: "Cmd+Shift+D" / "Option+Space" on a Mac, "Ctrl+Alt+Space" elsewhere. */
export function shortcutLabel(id: string, mac: boolean): string {
  const parts = id.split("+");
  const key = parts.pop()!;
  const names: Record<string, string> = mac
    ? { Ctrl: "Control", Alt: "Option", Shift: "Shift", Meta: "Cmd" }
    : { Ctrl: "Ctrl", Alt: "Alt", Shift: "Shift", Meta: "Win" };
  const k = CODE_LABELS[key] ?? key.replace(/^Numpad/, "Num ");
  return [...parts.map((p) => names[p] ?? p), k].join("+");
}

/**
 * The shortcut id a menu accelerator ("Shift+Ctrl+Z", "Alt+Up") stands for.
 * Menu "Ctrl" is CmdOrCtrl: Cmd on a Mac.
 */
export function accelToShortcut(accel: string, mac: boolean): string {
  const parts = accel.split("+");
  const key = parts.pop()!;
  const mods = new Set(parts.map((p) => (p === "Ctrl" || p === "CmdOrCtrl" ? (mac ? "Meta" : "Ctrl") : p === "Cmd" ? "Meta" : p)));
  const k = key.length === 1 && /[a-z]/i.test(key) ? key.toUpperCase() : key;
  return [...MODS.filter((m) => mods.has(m)), k].join("+");
}

const LIST_LINE = /^\s*(?:[-*+]|\d+[.)])\s/;

/**
 * Text with structure commands ("new bullet …", "new heading …"): each one
 * starts a list item, task or heading on its own line. A bullet right after a
 * list line continues that list (one line break); anywhere else it starts a
 * new block (a blank line), as Markdown needs.
 */
function fitStructure(before: string, after: string, text: string): string {
  const parts = text.split(/([\uE001-\uE003])/);
  let out = fitDictation(before, "", parts[0]).replace(/\s+$/, "");
  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i];
    const words = parts[i + 1].trim();
    const sofar = before + out;
    const lastLine = sofar.slice(sofar.lastIndexOf("\n") + 1);
    const atStart = sofar.trim() === "";
    const prefix = marker === BULLET ? "- " : marker === TASK ? "- [ ] " : "## ";
    let gap = "\n\n";
    if (atStart) gap = sofar.endsWith("\n") || sofar === "" ? "" : "\n\n";
    else if (marker !== HEADING && LIST_LINE.test(lastLine)) gap = "\n";
    else if (sofar.endsWith("\n\n")) gap = "";
    else if (sofar.endsWith("\n")) gap = "\n";
    out += gap + prefix + words.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  }
  if (after && !after.startsWith("\n")) out += "\n\n";
  return out;
}
