// Frontend keyboard-accelerator engine. On Linux/Windows (and the browser dev
// build) there is no native menu, so the accelerators that used to come from it
// are matched here instead, driven by the same tree in menudata.ts.

import { menuAccelerators } from "./menudata";
import { executeCommand } from "./commands";

interface Chord {
  ctrlMeta: boolean; // Cmd/Ctrl/CmdOrCtrl — matches ctrlKey || metaKey
  alt: boolean;
  shift: boolean;
  code: string;
}

const NAMED_CODES: Record<string, string> = {
  comma: "Comma", period: "Period", slash: "Slash", backslash: "Backslash",
  equal: "Equal", minus: "Minus", bracketleft: "BracketLeft",
  bracketright: "BracketRight", backquote: "Backquote", enter: "Enter",
  space: "Space", tab: "Tab", escape: "Escape",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
};

const PRIMARY = new Set(["cmd", "command", "cmdorctrl", "ctrl", "control", "meta", "super"]);

function tokenToCode(token: string): string {
  if (/^[a-z]$/i.test(token)) return "Key" + token.toUpperCase();
  if (/^[0-9]$/.test(token)) return "Digit" + token;
  if (/^digit[0-9]$/i.test(token)) return "Digit" + token.slice(-1);
  if (/^f[0-9]{1,2}$/i.test(token)) return "F" + token.slice(1);
  return NAMED_CODES[token.toLowerCase()] ?? token;
}

function parseAccel(accel: string): Chord {
  const chord: Chord = { ctrlMeta: false, alt: false, shift: false, code: "" };
  for (const raw of accel.split("+")) {
    const t = raw.trim();
    const low = t.toLowerCase();
    if (PRIMARY.has(low)) chord.ctrlMeta = true;
    else if (low === "alt" || low === "option") chord.alt = true;
    else if (low === "shift") chord.shift = true;
    else chord.code = tokenToCode(t);
  }
  return chord;
}

/** Build a keydown handler matching the menu's accelerators. Modifier state must
 *  match exactly, so Shift+Ctrl+N never fires the plain Ctrl+N binding. */
export function makeMenuKeyHandler(): (e: KeyboardEvent) => void {
  const chords = menuAccelerators().map(({ accel, id }) => ({ chord: parseAccel(accel), id }));
  return (e: KeyboardEvent) => {
    const ctrlMeta = e.ctrlKey || e.metaKey;
    for (const { chord, id } of chords) {
      if (
        chord.code === e.code &&
        chord.ctrlMeta === ctrlMeta &&
        chord.alt === e.altKey &&
        chord.shift === e.shiftKey
      ) {
        e.preventDefault();
        executeCommand(id);
        return;
      }
    }
  };
}
