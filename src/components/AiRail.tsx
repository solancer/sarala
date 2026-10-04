/**
 * Slim bar on the window's right edge: the way into the AI assistant.
 *
 * The top button toggles the panel (an accent marker shows it is open, a badge
 * counts changes waiting for review, and a ring pulses while the agent works).
 * Below it, "Ask about selection" attaches the selection and opens the panel
 * without sending anything; settings sit at the bottom. Nothing on the rail
 * starts an agent run: that stays behind clearly labelled actions (the
 * panel's suggestion cards, the command palette, the View menu).
 * Hidden in focus mode and when turned off in Settings > AI.
 */
import { Show, createMemo } from "solid-js";
import { isMac } from "../platform";
import { aiEnabled, aiPanelOpen, setAiPanelOpen } from "../ai/config";
import { askAboutSelection, docBusy, docPendingProposals } from "../ai/session";
import { AiIcon } from "./AiIcons";
import "../styles/ai.css";
import { setupNeeded } from "../ai/availability";
import { openSettings } from "./SettingsModal";

export default function AiRail() {
  // Across every chat on this document.
  const pending = createMemo(() => docPendingProposals().length);
  const busy = docBusy;
  const shortcut = isMac ? "⇧⌘I" : "Ctrl+Shift+I";

  return (
    <nav class="ai-rail" aria-label="AI assistant">
      <button
        class="ai-rail-btn ai-rail-main"
        classList={{ on: aiPanelOpen(), busy: busy() }}
        data-tip={aiPanelOpen() ? "Hide assistant" : setupNeeded() ? "AI assistant: setup needed" : "AI assistant"}
        aria-label="AI assistant" aria-pressed={aiPanelOpen()} aria-controls="ai-panel"
        onClick={() => setAiPanelOpen(!aiPanelOpen())}
      >
        <AiIcon name="sparkle" />
        <Show when={busy()}><span class="ai-rail-ring" aria-hidden="true" /></Show>
        <Show when={pending()}>
          <span class="ai-rail-badge" aria-label={`${pending()} changes to review`}>{pending()}</span>
        </Show>
        <Show when={setupNeeded() && !pending()}>
          <span class="ai-rail-setup" aria-label="Setup needed" />
        </Show>
      </button>
      <Show when={aiEnabled()}>
        <span class="ai-rail-sep" aria-hidden="true" />
        <button
          class="ai-rail-btn" data-tip={`Ask about selection (${shortcut})`} aria-label="Ask about selection"
          // Keep the editor selection: act on mousedown without taking focus.
          onMouseDown={(e) => { e.preventDefault(); askAboutSelection(); }}
        >
          <AiIcon name="selection" />
        </button>
      </Show>
      <span class="ai-rail-grow" />
      <button class="ai-rail-btn" data-tip="AI settings" aria-label="AI settings" onClick={() => openSettings("ai")}>
        <AiIcon name="settings" />
      </button>
    </nav>
  );
}
