/**
 * Agent availability UI: one card per agent CLI with its state (ready, signed
 * out, not installed), what to do about it (install command with Copy, a link
 * to its install guide, Sign in), and a "Check again" control. Used by the
 * onboarding screen and by the screen shown when no agent is installed.
 */
import { For, Show, createSignal } from "solid-js";
import { AGENTS, aiAgent, setAiAgent, type AgentInfo } from "../ai/config";
import { agentStatuses, agentsChecked, canRun, checkingAgents, refreshAgents } from "../ai/availability";
import { clipboardWriteText, openExternal } from "../platform";
import type { AgentStatus } from "../ai/transport";
import { AgentMark, AiIcon } from "./AiIcons";
import { createLogin, OutputLine } from "./AiSettings";
import { openSettings } from "./SettingsModal";

type Tone = "ready" | "warn" | "off" | "unknown";

function describe(s: AgentStatus | null | undefined, checked: boolean): { tone: Tone; label: string } {
  if (!checked || s === undefined) return { tone: "unknown", label: "Checking…" };
  if (!s?.installed) return { tone: "off", label: "Not installed" };
  if (s.signedIn === false) return { tone: "warn", label: "Signed out" };
  if (s.signedIn === true) return { tone: "ready", label: "Ready" };
  return { tone: "ready", label: "Installed" };
}

function CopyCommand(props: { command: string }) {
  const [copied, setCopied] = createSignal(false);
  return (
    <div class="ai-cmd">
      <code>{props.command}</code>
      <button
        class="ai-cmd-copy" aria-label="Copy install command" title="Copy"
        onClick={() => {
          void clipboardWriteText(props.command);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
      >
        <AiIcon name={copied() ? "check" : "copy"} />
      </button>
    </div>
  );
}

function AgentCard(props: { a: AgentInfo; selectable: boolean }) {
  const s = () => agentStatuses()[props.a.id];
  const d = () => describe(s(), agentsChecked());
  const login = createLogin(() => props.a.id);
  const selected = () => props.selectable && !!s()?.installed && aiAgent() === props.a.id;
  const pick = () => { if (props.selectable && s()?.installed) void setAiAgent(props.a.id); };

  const row = () => (
    <>
      <AgentMark agent={props.a.id} />
      <div class="ai-agent-text">
        <span class="ai-agent-name">{props.a.label}</span>
        <span class="ai-agent-blurb">{s()?.version ?? props.a.blurb}</span>
      </div>
      <span class="ai-pill" data-tone={d().tone}>
        <i class="ai-dot" data-tone={d().tone} />{d().label}
      </span>
    </>
  );

  return (
    <div class="ai-agent-card" classList={{ selected: selected(), missing: d().tone === "off", pickable: props.selectable && !!s()?.installed }}>
      <Show when={props.selectable} fallback={<div class="ai-agent-row ai-agent-pick">{row()}</div>}>
        <button
          class="ai-agent-row ai-agent-pick" aria-pressed={selected()} disabled={!s()?.installed}
          aria-label={`Use ${props.a.label}${d().label ? `, ${d().label}` : ""}`}
          onClick={pick}
        >
          {row()}
        </button>
      </Show>
      <Show when={agentsChecked() && s() !== undefined && !s()?.installed && props.a.install}>
        <div class="ai-agent-howto">
          <CopyCommand command={props.a.install} />
          <span class="ai-agent-note">
            Needs Node.js.{" "}
            <Show when={props.a.url}>
              <a href={props.a.url} onClick={(e) => { e.preventDefault(); void openExternal(props.a.url); }}>Other ways to install</a>
            </Show>
          </span>
        </div>
      </Show>
      <Show when={s()?.installed && (s()?.signedIn === false || login.running() || login.error())}>
        <div class="ai-agent-howto">
          <Show
            when={!login.running()}
            fallback={<button class="ai-secondary" onClick={login.cancel}>Cancel sign-in</button>}
          >
            <button class="ai-secondary" onClick={() => void login.start()}><AiIcon name="login" />Sign in</button>
          </Show>
          <Show when={login.output().length}>
            <div class="ai-banner-output">
              <For each={login.output().slice(-3)}>{(line) => <OutputLine line={line} />}</For>
            </div>
          </Show>
          <Show when={login.error()}><span class="ai-banner-error">{login.error()}</span></Show>
        </div>
      </Show>
    </div>
  );
}

/** Every agent's card, plus Check again. `selectable` lets a card choose the default agent. */
export function AgentCards(props: { selectable?: boolean }) {
  return (
    <div class="ai-agent-cards" role="group" aria-label="Agents">
      <For each={AGENTS}>{(a) => <AgentCard a={a} selectable={!!props.selectable} />}</For>
      <div class="ai-agent-foot">
        <button class="ai-quiet" disabled={checkingAgents()} onClick={() => void refreshAgents(true)}>
          <Show when={checkingAgents()} fallback={<AiIcon name="refresh" />}>
            <span class="ai-spinner sm" aria-hidden="true" />
          </Show>
          {checkingAgents() ? "Checking…" : "Check again"}
        </button>
        <button class="ai-link" onClick={() => openSettings("ai")}>Installed somewhere else?</button>
      </div>
    </div>
  );
}

/** Shown instead of the chat when the assistant is on but no agent is installed. */
export function InstallScreen() {
  return (
    <div class="ai-install">
      <div class="ai-orb muted" aria-hidden="true"><AiIcon name="download" /></div>
      <h2 class="ai-hero-title">Install an agent to get started</h2>
      <p class="ai-hero-lede">
        The assistant runs an AI agent CLI installed on this computer, with your own sign-in. Install one of these, then
        come back: Sarala checks again automatically.
      </p>
      <AgentCards />
    </div>
  );
}

export { canRun };
