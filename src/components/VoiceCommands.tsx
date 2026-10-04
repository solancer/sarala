/**
 * "What can I say?": every voice command and key, grouped by what you're
 * trying to do. Opened by saying "what can I say", from the voice panel, Edit
 * > Voice Typing > Voice Commands, the command palette, or Settings > Voice.
 *
 * Built as headings and description lists so screen readers can move by
 * section and hear each phrase with what it does.
 */
import { For, Show } from "solid-js";
import ModalFrame from "./ModalFrame";
import { MicIcon } from "./VoiceHud";
import {
  commandKeyLabel, setVoiceCommands, setVoicePunctuation, shortcutLabel, voiceCommandKey, voiceCommands, voicePunctuation, voiceShortcut,
} from "../voice/config";
import { commandsOpen, setCommandsOpen } from "../voice/session";
import { isMac } from "../platform";

interface Entry {
  say: string[];
  does: string;
}

const WRITING: Entry[] = [
  { say: ["new paragraph"], does: "Starts a new paragraph." },
  { say: ["new line"], does: "Starts a new line in the same paragraph." },
  { say: ["new bullet …", "next bullet …"], does: "Starts a list item; after a list item it continues the list." },
  { say: ["new task …"], does: "Starts a checklist item." },
  { say: ["new heading …"], does: "Starts a heading." },
];

const CHANGING: Entry[] = [
  { say: ["scratch that"], does: "Removes what you just said. “Delete that” and “undo that” work too." },
  { say: ["select that"], does: "Selects it, so you can say it again or type over it." },
  { say: ["make that bold", "make that italic"], does: "Makes it bold or italic. “Bold that” works too." },
  { say: ["make that a heading"], does: "Turns its line into a heading." },
  { say: ["make that a bullet", "make that a task"], does: "Turns its line into a list item or a checklist item." },
];

const TABLES: Entry[] = [
  { say: ["new table", "new table 3 by 4"], does: "Inserts a table (default 3 rows by 2 columns, or the size you say)." },
  { say: ["add a row", "add a column"], does: "Adds one at the table's edge." },
  { say: ["row above", "row below"], does: "Adds a row next to the one you're in." },
  { say: ["column before", "column after"], does: "Adds a column next to the one you're in." },
  { say: ["delete row", "delete column"], does: "Removes the one you're in." },
  { say: ["move row up", "move row down"], does: "Reorders rows." },
  { say: ["move column left", "move column right"], does: "Reorders columns." },
  { say: ["align left", "align center", "align right"], does: "Aligns the column you're in." },
];

const CONTROL: Entry[] = [
  { say: ["stop listening"], does: "Finishes and keeps the text." },
  { say: ["what can I say"], does: "Shows this list." },
];

const PUNCTUATION: Entry[] = [
  { say: ["comma", "period", "full stop"], does: ", ." },
  { say: ["question mark", "exclamation point"], does: "? !" },
  { say: ["colon", "semicolon", "ellipsis"], does: ": ; …" },
  { say: ["open quote", "close quote"], does: "“ ”" },
  { say: ["open paren", "close paren"], does: "( )" },
  { say: ["hyphen"], does: "-" },
];

function Section(props: { title: string; entries: Entry[]; note?: string }) {
  return (
    <section class="voice-cmd-section">
      <h3>{props.title}</h3>
      <Show when={props.note}><p class="voice-cmd-note">{props.note}</p></Show>
      <dl>
        <For each={props.entries}>
          {(e) => (
            <div class="voice-cmd-row">
              <dt>
                <For each={e.say}>{(p) => <span class="voice-cmd-phrase">“{p}”</span>}</For>
              </dt>
              <dd>{e.does}</dd>
            </div>
          )}
        </For>
      </dl>
    </section>
  );
}

export default function VoiceCommands() {
  const close = () => setCommandsOpen(false);
  return (
    <Show when={commandsOpen()}>
      <div class="settings-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
        <ModalFrame class="voice-setup voice-commands" label="Voice commands" onClose={close}>
          <header class="voice-setup-head">
            <span class="voice-setup-badge" aria-hidden="true"><MicIcon /></span>
            <div>
              <h2>What you can say</h2>
              <p>
                Say commands while you dictate; say the ones that change what you just said on their own, after a short pause.
                <Show when={voiceCommandKey() !== "off"}> Or hold {commandKeyLabel(voiceCommandKey())} while you say one: then it is never typed, and “undo”, “redo” and “new paragraph” work on their own too.</Show>
              </p>
            </div>
          </header>

          <Show when={!voiceCommands()}>
            <div class="voice-setup-note voice-cmd-off">
              <span>Voice commands are off, so these are typed as words.</span>
              <button class="pandoc-btn primary" onClick={() => void setVoiceCommands(true)}>Turn on</button>
            </div>
          </Show>

          <Section title="Writing" entries={WRITING} />
          <Section title="Changing what you just said" entries={CHANGING} />
          <Section title="Tables" entries={TABLES} />
          <Section title="Finishing" entries={CONTROL} />
          <section class="voice-cmd-section">
            <h3>Keys</h3>
            <dl>
              <Show when={voiceCommandKey() !== "off"}>
                <div class="voice-cmd-row"><dt><kbd>{commandKeyLabel(voiceCommandKey())}</kbd></dt><dd>Tap to start or stop. Hold it and say a command: nothing you say while holding it is typed.</dd></div>
              </Show>
              <div class="voice-cmd-row"><dt><kbd>{shortcutLabel(voiceShortcut())}</kbd></dt><dd>Start, and again to finish. Hold it to talk, if you prefer.</dd></div>
              <div class="voice-cmd-row"><dt><kbd>{isMac ? "Return" : "Enter"}</kbd></dt><dd>Finish and keep the text.</dd></div>
              <div class="voice-cmd-row"><dt><kbd>Esc</kbd></dt><dd>Discard what you said. {isMac ? "Cmd" : "Ctrl"}+Z brings it back.</dd></div>
            </dl>
          </section>
          <Section
            title="Punctuation"
            entries={PUNCTUATION}
            note={voicePunctuation() ? undefined : "Off: the speech model punctuates as you speak. Turn it on to say punctuation instead."}
          />
          <div class="voice-setup-actions">
            <Show when={!voicePunctuation()}>
              <button class="pandoc-btn ghost" onClick={() => void setVoicePunctuation(true)}>Turn on spoken punctuation</button>
            </Show>
            <button class="pandoc-btn primary" onClick={close}>Done</button>
          </div>
        </ModalFrame>
      </div>
    </Show>
  );
}
