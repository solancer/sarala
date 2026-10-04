/**
 * Agent status and sign-in, shared by Settings > AI and the assistant panel.
 *
 * Sign-in runs the CLI's own login command, which opens the provider's OAuth
 * page in the browser. Sarala never sees or stores the resulting credentials;
 * it only shows the command's output (device codes, links) while it runs.
 */
import { For, Show, createResource, createSignal, onCleanup } from "solid-js";
import { agentInfo, aiAgent, aiAgentPath, bumpStatus, statusEpoch } from "../ai/config";
import { agentLogin, agentStatus, type RunHandle } from "../ai/transport";
import { isTauri, openExternal } from "../platform";
import type { AgentId } from "../ai/types";

const URL_RE = /https?:\/\/[^\s"'<>]+/g;

/** A line of CLI output with its URLs made clickable. */
export function OutputLine(props: { line: string }) {
  const parts = () => {
    const out: { text: string; url?: string }[] = [];
    let last = 0;
    for (const m of props.line.matchAll(URL_RE)) {
      if (m.index > last) out.push({ text: props.line.slice(last, m.index) });
      out.push({ text: m[0], url: m[0] });
      last = m.index + m[0].length;
    }
    if (last < props.line.length) out.push({ text: props.line.slice(last) });
    return out;
  };
  return (
    <div>
      <For each={parts()}>
        {(p) => (p.url
          ? <a href={p.url} onClick={(e) => { e.preventDefault(); void openExternal(p.url!); }}>{p.text}</a>
          : <span>{p.text}</span>)}
      </For>
    </div>
  );
}

/** State for one run of an agent's sign-in command (default: the current agent). */
export function createLogin(agent: () => AgentId = aiAgent) {
  const [output, setOutput] = createSignal<string[]>([]);
  const [running, setRunning] = createSignal(false);
  const [error, setError] = createSignal("");
  let handle: RunHandle | null = null;
  onCleanup(() => handle?.cancel());

  const start = async () => {
    setError("");
    setOutput([]);
    setRunning(true);
    try {
      handle = await agentLogin(agent(), agent() === aiAgent() ? aiAgentPath() : "", {
        // ANSI colour codes are stripped; device codes and URLs stay visible.
        onLine: (line) => setOutput((o) => [...o.slice(-30), line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")]),
        onExit: (exit) => {
          handle = null;
          setRunning(false);
          if (exit.code !== 0 && !exit.cancelled) {
            setError(exit.stderr?.trim().split("\n").slice(-2).join(" ") || "Sign-in did not finish.");
          }
          bumpStatus();
        },
      });
    } catch (e) {
      setRunning(false);
      setError(String(e instanceof Error ? e.message : e));
    }
  };
  return { output, running, error, start, cancel: () => handle?.cancel() };
}

/** Status of an agent (default: the current one), refetched when it, its path or sign-in changes. */
export function createAgentStatus(active: () => boolean = () => true, agent: () => AgentId = aiAgent) {
  return createResource(
    () => (active() ? ([agent(), agent() === aiAgent() ? aiAgentPath() : "", statusEpoch()] as const) : false),
    ([a, path]) => agentStatus(a, path).catch(() => null),
  );
}

export function AiAgentStatus() {
  const [status, { refetch }] = createAgentStatus();
  const login = createLogin();

  const summary = () => {
    const s = status();
    if (status.loading) return "Checking…";
    if (!isTauri && aiAgent() !== "mock") return "Agent CLIs are only available in the desktop app.";
    if (!s?.installed) return "Not found on this computer.";
    const version = s.version ? `${s.version}` : "Installed";
    if (s.signedIn === true) return `${version}. Signed in${s.account ? ` as ${s.account}` : ""}.`;
    if (s.signedIn === false) return `${version}. Not signed in.`;
    return `${version}. Sign in if the first request fails.`;
  };

  return (
    <div class="ai-set-key">
      <span class="ai-set-status" classList={{ ok: status()?.signedIn === true }}>{summary()}</span>
      <Show when={status() && !status()!.installed && agentInfo(aiAgent()).install}>
        <code class="ai-set-install">{agentInfo(aiAgent()).install}</code>
      </Show>
      <Show when={status()?.path}>
        <span class="ai-set-path" title={status()!.path!}>{status()!.path}</span>
      </Show>
      <div class="ai-set-field">
        <Show when={status()?.installed && aiAgent() !== "mock"}>
          <Show
            when={!login.running()}
            fallback={<button class="ghost-btn" onClick={login.cancel}>Cancel sign-in</button>}
          >
            <button class="ghost-btn" onClick={() => void login.start()}>
              {status()?.signedIn ? "Sign in again" : "Sign in…"}
            </button>
          </Show>
        </Show>
        <button class="ghost-btn" onClick={() => void refetch()}>Refresh</button>
      </div>
      <Show when={login.output().length}>
        <div class="ai-set-output" aria-live="polite">
          <For each={login.output()}>{(line) => <OutputLine line={line} />}</For>
        </div>
      </Show>
      <Show when={login.error()}><span class="ai-set-error">{login.error()}</span></Show>
    </div>
  );
}
