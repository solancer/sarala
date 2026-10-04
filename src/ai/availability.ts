/**
 * Which agent CLIs are installed and signed in on this computer.
 *
 * Checked when the assistant panel opens, when the window regains focus
 * (throttled), and when the assistant is turned on, so installing or signing
 * in elsewhere is picked up without a restart. Drives the onboarding cards,
 * the "install an agent" screen, the composer's disabled state and the rail's
 * setup dot, and moves off an agent that has gone away.
 */
import { createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { AGENTS, agentInfo, agentPathFor, aiAgent, aiEnabled, aiPanelOpen, setAiAgent, statusEpoch } from "./config";
import { agentStatus, type AgentStatus } from "./transport";
import type { AgentId } from "./types";

const [statuses, setStatuses] = createSignal<Partial<Record<AgentId, AgentStatus | null>>>({});
const [checking, setChecking] = createSignal(false);
const [checkedOnce, setCheckedOnce] = createSignal(false);
/** A one-line note after the assistant moved to another agent on its own. */
export const [switchNote, setSwitchNote] = createSignal<string | null>(null);

export const agentStatuses = statuses;
export const checkingAgents = checking;
/** True once every agent has been checked at least once. */
export const agentsChecked = checkedOnce;

/** Installed and not known to be signed out. */
export function canRun(s: AgentStatus | null | undefined): boolean {
  return !!s?.installed && s.signedIn !== false;
}

/** Best agent to use: signed in, then unknown sign-in, then installed at all. */
export function bestAgent(all: Partial<Record<AgentId, AgentStatus | null>>): AgentId | null {
  const rank = (s: AgentStatus | null | undefined) =>
    !s?.installed ? 0 : s.signedIn === true ? 3 : s.signedIn === null ? 2 : 1;
  let best: AgentId | null = null;
  for (const a of AGENTS) {
    if (a.id === "mock") continue; // never auto-picked
    if (rank(all[a.id]) > (best ? rank(all[best]) : 0)) best = a.id;
  }
  return best;
}

export const anyInstalled = createMemo(() => AGENTS.some((a) => statuses()[a.id]?.installed));
export const anyRunnable = createMemo(() => AGENTS.some((a) => canRun(statuses()[a.id])));
/** The assistant is on but nothing can run: shown as a dot on the rail. */
export const setupNeeded = createMemo(() => aiEnabled() && checkedOnce() && !anyRunnable());

let last = 0;
let inflight: Promise<void> | null = null;

/**
 * Check every agent (about 5 short CLI processes, ~130 ms in parallel).
 * Unforced checks (window focus) run at most every 30 s; `force` (panel
 * opened, Check again, sign-in) always runs.
 */
export function refreshAgents(force = false): Promise<void> {
  if (inflight) return inflight;
  if (!force && Date.now() - last < 30_000) return Promise.resolve();
  setChecking(true);
  inflight = Promise.all(
    AGENTS.map(async (a) => [a.id, await agentStatus(a.id, agentPathFor(a.id)).catch(() => null)] as const),
  ).then((pairs) => {
    setStatuses(Object.fromEntries(pairs));
    setCheckedOnce(true);
  }).finally(() => {
    last = Date.now();
    inflight = null;
    setChecking(false);
  });
  return inflight;
}

/** Turning the assistant on: start with the agent most likely to work. */
export function pickWorkingAgent() {
  const best = bestAgent(statuses());
  if (best && !canRun(statuses()[aiAgent()])) void setAiAgent(best);
}

createRoot(() => {
  // Check when the panel opens or the assistant is turned on, and again after
  // a sign-in or path change.
  let startup = true;
  createEffect(on([aiPanelOpen, aiEnabled, statusEpoch], ([open, on_]) => {
    if (open) void refreshAgents(true);
    else if (on_ && startup) {
      // At launch the check only feeds the rail's setup dot: run it once the
      // app is idle rather than spawning CLIs while it starts up.
      const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
      if (idle) idle(() => void refreshAgents(), { timeout: 3000 });
      else setTimeout(() => void refreshAgents(), 1500);
    } else if (on_) void refreshAgents(true);
    startup = false;
  }));
  if (typeof window !== "undefined") {
    window.addEventListener("focus", () => { if (aiEnabled() || aiPanelOpen()) void refreshAgents(); });
  }
  // The chosen agent went away (uninstalled, path changed): move to one that works.
  createEffect(on(statuses, (all) => {
    if (!aiEnabled() || aiAgent() === "mock") return;
    const current = all[aiAgent()];
    if (current === undefined || current?.installed) return;
    const best = bestAgent(all);
    if (!best) return;
    setSwitchNote(`${agentInfo(aiAgent()).label} isn't installed, so new chats use ${agentInfo(best).label}.`);
    void setAiAgent(best);
  }, { defer: true }));
});
