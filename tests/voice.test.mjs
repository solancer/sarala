/**
 * Tests for voice typing's pure logic (src/voice/text.ts): fitting dictated
 * words into the text around the caret, the spoken "new paragraph" command,
 * and matching the hold-to-talk shortcut.
 *
 *   node tests/voice.test.mjs   (part of `pnpm test`)
 *
 * The Rust side (capture, resampling, voice detection, the engine) has its own
 * tests: `cargo test` in src-tauri, plus an ignored live test with a model.
 */
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(here, ".build", "voice");
await build({
  entryPoints: [path.join(here, "..", "src", "voice", "text.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  outdir,
  logLevel: "error",
});
const {
  splitTrailingCommand, fitDictation, applyVoiceCommands, matchesShortcut, isShortcutKey, voiceAction, tableSize,
  shortcutFromEvent, shortcutLabel, accelToShortcut,
} = await import(path.join(outdir, "text.js"));

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log(`ok - ${name}`);
};

test("words get a space where they would touch", () => {
  assert.equal(fitDictation("Hello", "", "world."), " world.");
  assert.equal(fitDictation("Hello ", "", "world."), "world.");
  assert.equal(fitDictation("", "", "  Hello. "), "Hello.");
  assert.equal(fitDictation("", "rest", "Start"), "Start ");
  assert.equal(fitDictation("(", ")", "aside"), "aside");
  assert.equal(fitDictation("one ", " two", "middle"), "middle");
});

test("mid-sentence, the model's capital is lowered", () => {
  assert.equal(fitDictation("I went to the", "", "Market today."), " market today.");
  assert.equal(fitDictation("Yes,", "", "That works."), " that works.");
  // After a full stop it stays, or is added.
  assert.equal(fitDictation("Done.", "", "Next one."), " Next one.");
  assert.equal(fitDictation("Done.", "", "next one."), " Next one.");
  assert.equal(fitDictation("", "", "hello there."), "Hello there.");
  // After a colon the model's choice stands.
  assert.equal(fitDictation("Log:", "", "First thought."), " First thought.");
  assert.equal(fitDictation("ratio:", "", "two to one"), " two to one");
  // "I" and acronyms keep their capitals.
  assert.equal(fitDictation("and", "", "I think so."), " I think so.");
  assert.equal(fitDictation("the", "", "NASA launch."), " NASA launch.");
});

test("inside Markdown syntax", () => {
  assert.equal(fitDictation("- ", "", "Buy milk."), "Buy milk.");
  assert.equal(fitDictation("## ", "", "Overview"), "Overview");
  // Between emphasis markers: no spaces, or it would not be bold.
  assert.equal(fitDictation("**", "**", "bold words"), "bold words");
  assert.equal(fitDictation("some _", "_", "italic"), "italic");
  // After a closing marker it is a new word.
  assert.equal(fitDictation("**bold**", "", "after"), " after");
});

test('"new paragraph" becomes a paragraph break', () => {
  assert.equal(applyVoiceCommands("First point. New paragraph. second point."), "First point.\n\nSecond point.");
  assert.equal(applyVoiceCommands("one, new paragraph two"), "one\n\nTwo");
  assert.equal(applyVoiceCommands("New paragraph. Start here."), "Start here.");
  assert.equal(applyVoiceCommands("Ends here. New paragraph."), "Ends here.");
  assert.equal(applyVoiceCommands("A paragraph about newness."), "A paragraph about newness.");
});

const key = (init) => ({ altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, code: "", key: "", ...init });

test("shortcut matching uses the physical key and exact modifiers", () => {
  assert.ok(matchesShortcut(key({ altKey: true, code: "Space", key: " " }), "Alt+Space"));
  assert.ok(!matchesShortcut(key({ altKey: true, shiftKey: true, code: "Space" }), "Alt+Space"));
  assert.ok(!matchesShortcut(key({ code: "Space", key: " " }), "Alt+Space"));
  // Option+D types ∂ on macOS: the code still matches.
  assert.ok(matchesShortcut(key({ metaKey: true, shiftKey: true, code: "KeyD", key: "∂" }), "Meta+Shift+D"));
  assert.ok(matchesShortcut(key({ ctrlKey: true, altKey: true, code: "Space" }), "Ctrl+Alt+Space"));
  assert.ok(matchesShortcut(key({ key: "F5", code: "F5" }), "F5"));
  assert.ok(!matchesShortcut(key({ key: "F5", code: "F5", ctrlKey: true }), "F5"));
});

test("releasing any key of the shortcut ends a hold", () => {
  assert.ok(isShortcutKey(key({ code: "Space", key: " " }), "Alt+Space"));
  assert.ok(isShortcutKey(key({ key: "Alt", code: "AltLeft" }), "Alt+Space"));
  assert.ok(isShortcutKey(key({ key: "Control", code: "ControlLeft" }), "Ctrl+Alt+Space"));
  assert.ok(!isShortcutKey(key({ key: "Shift", code: "ShiftLeft" }), "Alt+Space"));
  assert.ok(!isShortcutKey(key({ key: "a", code: "KeyA" }), "Alt+Space"));
});

test('"new line" is a line break; layout commands can be turned off', () => {
  assert.equal(applyVoiceCommands("Dear Sam, new line thanks for writing."), "Dear Sam\nThanks for writing.");
  assert.equal(applyVoiceCommands("one new paragraph two", { layout: false }), "one new paragraph two");
});

test("spoken punctuation, when turned on", () => {
  const p = (t) => applyVoiceCommands(t, { punctuation: true });
  assert.equal(p("hello comma world period"), "hello, world.");
  assert.equal(p("Hello, comma, world."), "Hello, world.");
  assert.equal(p("is it ready question mark yes exclamation point"), "is it ready? Yes!");
  assert.equal(p("she said open quote hi close quote"), 'she said "hi"');
  assert.equal(p("note open paren draft close paren"), "note (draft)");
  assert.equal(p("a well hyphen known fact"), "a well-known fact");
  // Off by default: the words stay words.
  assert.equal(applyVoiceCommands("a period of time"), "a period of time");
});

test("commands said on their own", () => {
  assert.equal(voiceAction("Scratch that."), "scratch");
  assert.equal(voiceAction("delete that"), "scratch");
  assert.equal(voiceAction("Undo that!"), "scratch");
  assert.equal(voiceAction("Stop listening."), "stop");
  assert.equal(voiceAction("Please scratch that idea"), null);
  assert.equal(voiceAction("We should stop listening to rumours."), null);
});

test("recording a shortcut follows WCAG 2.1.4", () => {
  const rec = (init) => shortcutFromEvent(key(init));
  assert.deepEqual(rec({ metaKey: true, shiftKey: true, code: "KeyD", key: "D" }), { id: "Shift+Meta+D" });
  assert.deepEqual(rec({ ctrlKey: true, altKey: true, code: "Space", key: " " }), { id: "Ctrl+Alt+Space" });
  assert.deepEqual(rec({ code: "F9", key: "F9" }), { id: "F9" }); // function keys may stand alone
  assert.deepEqual(rec({ code: "Insert", key: "Insert" }), { id: "Insert" });
  assert.deepEqual(rec({ altKey: true, code: "Backquote", key: "`" }), { id: "Alt+Backquote" });
  assert.ok("error" in rec({ code: "KeyD", key: "d" }), "a bare letter is refused");
  assert.ok("error" in rec({ shiftKey: true, code: "KeyD", key: "D" }), "Shift alone is not enough");
  assert.ok("error" in rec({ code: "Escape", key: "Escape" }));
  assert.ok("error" in rec({ ctrlKey: true, code: "Tab", key: "Tab" }));
  assert.equal(rec({ key: "Shift", code: "ShiftLeft", shiftKey: true }), null, "still choosing modifiers");
});

test("recorded shortcuts match and read well", () => {
  assert.ok(matchesShortcut(key({ shiftKey: true, metaKey: true, code: "KeyD" }), "Shift+Meta+D"));
  assert.ok(matchesShortcut(key({ altKey: true, code: "Backquote" }), "Alt+Backquote"));
  assert.ok(matchesShortcut(key({ ctrlKey: true, code: "Digit7", key: "7" }), "Ctrl+7"));
  assert.ok(matchesShortcut(key({ code: "Insert", key: "Insert" }), "Insert"));
  assert.equal(shortcutLabel("Meta+Shift+D", true), "Cmd+Shift+D");
  assert.equal(shortcutLabel("Alt+Space", true), "Option+Space");
  assert.equal(shortcutLabel("Ctrl+Alt+Space", false), "Ctrl+Alt+Space");
  assert.equal(shortcutLabel("Alt+Backquote", false), "Alt+`");
});

test("menu accelerators map to shortcut ids for clash checks", () => {
  assert.equal(accelToShortcut("Shift+Ctrl+Z", true), "Shift+Meta+Z");
  assert.equal(accelToShortcut("Shift+Ctrl+Z", false), "Ctrl+Shift+Z");
  assert.equal(accelToShortcut("Alt+Ctrl+F", true), "Alt+Meta+F");
  assert.equal(accelToShortcut("Ctrl+K", false), "Ctrl+K");
});

const dictate = (before, said, after = "") => fitDictation(before, after, applyVoiceCommands(said));

test("structure commands: bullets, tasks and headings", () => {
  // From an empty block.
  assert.equal(dictate("", "new bullet buy milk new bullet call mom"), "- Buy milk\n- Call mom");
  // After a paragraph: a blank line first, then the list.
  assert.equal(dictate("Shopping:", "New bullet, buy milk. Next bullet, bread."), "\n\n- Buy milk.\n- Bread.");
  // Continuing an existing list: one line break.
  assert.equal(dictate("- Eggs", "new bullet point butter"), "\n- Butter");
  assert.equal(dictate("1. First", "new list item second"), "\n- Second");
  // Tasks and headings.
  assert.equal(dictate("", "new task finish the report"), "- [ ] Finish the report");
  assert.equal(dictate("Intro text.", "new heading project goals"), "\n\n## Project goals");
  assert.equal(dictate("- [ ] One", "new to do two"), "\n- [ ] Two");
  // Text, then structure.
  assert.equal(dictate("", "my list new bullet apples"), "My list\n\n- Apples");
  // A bare command leaves the prefix ready for the next dictation.
  assert.equal(dictate("", "new bullet"), "- ");
  // Ordinary prose is left alone.
  assert.equal(dictate("", "the main bullet point is cost"), "The main bullet point is cost");
  assert.equal(dictate("", "we need a new heading for this section"), "We need a new heading for this section");
  assert.equal(dictate("", "add the new task to the board"), "Add the new task to the board");
  // Still a command after punctuation or another command.
  assert.equal(dictate("", "Groceries. New bullet eggs."), "Groceries.\n\n- Eggs.");
});

test("acting on the last dictation", () => {
  assert.equal(voiceAction("Bold that."), "bold");
  assert.equal(voiceAction("make that bold"), "bold");
  assert.equal(voiceAction("Bolt that."), "bold");
  assert.equal(voiceAction("Scratched that."), "scratch");
  assert.equal(voiceAction("Italicize that"), "italic");
  assert.equal(voiceAction("Make that a heading."), "heading");
  assert.equal(voiceAction("make this a bullet point"), "bullet");
  assert.equal(voiceAction("Make that a list item"), "bullet");
  assert.equal(voiceAction("make that a to do"), "task");
  assert.equal(voiceAction("Select that."), "select");
  assert.equal(voiceAction("What can I say?"), "help");
  assert.equal(voiceAction("Show voice commands"), "help");
  // Only as the whole utterance.
  assert.equal(voiceAction("I want to make that bold choice"), null);
  assert.equal(voiceAction("Select that option from the menu"), null);
});

test("table commands", () => {
  // Inserting one.
  assert.deepEqual(tableSize("new table"), { rows: 3, cols: 2 });
  assert.deepEqual(tableSize("insert table"), { rows: 3, cols: 2 });
  assert.deepEqual(tableSize("new table 4 by 5"), { rows: 4, cols: 5 });
  assert.deepEqual(tableSize("add table three by six"), { rows: 3, cols: 6 });
  assert.deepEqual(tableSize("New table 2 x 2."), { rows: 2, cols: 2 });
  assert.equal(voiceAction("new table"), "table");
  assert.equal(voiceAction("new table 4 by 5"), "table");
  // Not a table of contents.
  assert.equal(tableSize("new table of contents"), null);
  assert.equal(voiceAction("new table of contents"), null);
  // Only as the whole utterance.
  assert.equal(voiceAction("let's add a new table here"), null);

  // Acting on the table at the caret.
  assert.equal(voiceAction("add a row"), "tableRowAdd");
  assert.equal(voiceAction("add row above"), "tableRowAbove");
  assert.equal(voiceAction("row below"), "tableRowBelow");
  assert.equal(voiceAction("delete the row"), "tableRowDelete");
  assert.equal(voiceAction("remove this row"), "tableRowDelete");
  assert.equal(voiceAction("add a column"), "tableColAdd");
  assert.equal(voiceAction("column before"), "tableColBefore");
  assert.equal(voiceAction("add column after"), "tableColAfter");
  assert.equal(voiceAction("delete column"), "tableColDelete");
  assert.equal(voiceAction("move the row up"), "tableRowUp");
  assert.equal(voiceAction("move row down"), "tableRowDown");
  assert.equal(voiceAction("move column left"), "tableColLeft");
  assert.equal(voiceAction("move the column right"), "tableColRight");
  assert.equal(voiceAction("align left"), "tableAlignLeft");
  assert.equal(voiceAction("align column center"), "tableAlignCenter");
  assert.equal(voiceAction("align the column right"), "tableAlignRight");
  // Not when the words are just part of a sentence.
  assert.equal(voiceAction("I'll add a row of numbers to my notes"), null);
});

test("a command as the last sentence, without a pause", () => {
  assert.deepEqual(splitTrailingCommand("This is a test. Make that bold."), { text: "This is a test.", action: "bold" });
  assert.deepEqual(splitTrailingCommand("First point. Second point! Scratch that"), { text: "First point. Second point!", action: "scratch" });
  assert.equal(splitTrailingCommand("I decided to make that bold."), null);
  assert.equal(splitTrailingCommand("Make that bold."), null); // a whole-utterance command is voiceAction's job
  assert.equal(splitTrailingCommand("It works. Mostly."), null);
});

console.log(`\n${n} tests passed`);
