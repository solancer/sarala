/**
 * Starts agent CLI runs through the Rust bridge (src-tauri/src/ai.rs) and
 * relays their output. Sarala holds no credentials: each CLI uses its own
 * sign-in. In the browser (`pnpm dev`) only the mock agent is available.
 */
import { isTauri } from "../platform";
import type { AgentId } from "./types";

export interface RunRequest {
  agent: AgentId;
  /** Binary path override from Settings; auto-detected when empty. */
  path: string;
  workspaceId: string;
  document: string;
  prompt: string;
  sessionId: string | null;
  model: string;
}

export interface RunExit {
  /** Exit code; null when killed or cancelled. */
  code: number | null;
  /** The working copy after the run (null for sign-in runs or when unreadable). */
  document: string | null;
  stderr: string | null;
  cancelled: boolean;
}

export interface RunCallbacks {
  onLine(line: string): void;
  onExit(exit: RunExit): void;
}

export interface RunHandle {
  cancel(): void;
}

export interface AgentStatus {
  installed: boolean;
  path: string | null;
  version: string | null;
  /** null when the CLI can't report it. */
  signedIn: boolean | null;
  account: string | null;
}

let seq = 0;
const newRequestId = () => `agent-${Date.now().toString(36)}-${(seq++).toString(36)}`;

const needsDesktop = () => new Error("Agent CLIs run in the desktop app. In the browser, only the Mock agent is available.");

interface Payload {
  requestId: string;
  kind: "line" | "exit";
  data?: string;
  code?: number | null;
  document?: string | null;
  stderr?: string | null;
}

/** Invoke a streaming command and route its `ai-agent` events to `cb`. */
async function streamCommand(command: string, args: Record<string, unknown>, cb: RunCallbacks): Promise<RunHandle> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const requestId = newRequestId();
  let done = false;
  let cancelled = false;
  const unlisten = await listen<Payload>("ai-agent", ({ payload }) => {
    if (payload.requestId !== requestId || done) return;
    if (payload.kind === "line") return cb.onLine(payload.data ?? "");
    done = true;
    unlisten();
    cb.onExit({
      code: payload.code ?? null,
      document: payload.document ?? null,
      stderr: payload.stderr ?? null,
      cancelled,
    });
  });
  try {
    await invoke(command, { requestId, ...args });
  } catch (e) {
    done = true;
    unlisten();
    throw new Error(String(e));
  }
  return {
    cancel: () => {
      if (done) return;
      cancelled = true;
      void invoke("ai_agent_cancel", { requestId });
    },
  };
}

export async function runAgent(req: RunRequest, cb: RunCallbacks): Promise<RunHandle> {
  // The mock is dev-only; Vite drops this branch (and the module) from builds.
  if (import.meta.env.DEV && req.agent === "mock") return (await import("./mock")).mockRun(req, cb);
  if (!isTauri) throw needsDesktop();
  return streamCommand("ai_agent_run", {
    agent: req.agent,
    path: req.path || null,
    workspaceId: req.workspaceId,
    document: req.document,
    prompt: req.prompt,
    sessionId: req.sessionId,
    model: req.model || null,
  }, cb);
}

/** Run the CLI's own sign-in, which opens the provider's page in the browser. */
export async function agentLogin(agent: AgentId, path: string, cb: RunCallbacks): Promise<RunHandle> {
  if (agent === "mock") {
    setTimeout(() => cb.onExit({ code: 0, document: null, stderr: null, cancelled: false }), 0);
    return { cancel() {} };
  }
  if (!isTauri) throw needsDesktop();
  return streamCommand("ai_agent_login", { agent, path: path || null }, cb);
}

export async function agentStatus(agent: AgentId, path: string): Promise<AgentStatus> {
  if (agent === "mock") {
    // Tests can simulate a computer with no agents at all.
    const none = (globalThis as { __saralaNoAgents?: boolean }).__saralaNoAgents;
    return { installed: !none, path: null, version: "mock", signedIn: none ? null : true, account: null };
  }
  if (!isTauri) return { installed: false, path: null, version: null, signedIn: null, account: null };
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<AgentStatus>("ai_agent_status", { agent, path: path || null });
}

/** Delete a chat's working copy. */
export async function forgetWorkspace(workspaceId: string): Promise<void> {
  if (!isTauri) return;
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ai_agent_forget", { workspaceId }).catch(() => {});
}

/* ---------- saved chats (see persist.ts) ---------- */

const LOCAL_KEY = (path: string) => `sarala.aiChats:${path}`;

export async function loadChats(docPath: string): Promise<unknown> {
  if (!isTauri) {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY(docPath)) ?? "null"); } catch { return null; }
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke("ai_chats_load", { docPath });
}

export async function saveChats(docPath: string, data: unknown): Promise<void> {
  if (!isTauri) {
    localStorage.setItem(LOCAL_KEY(docPath), JSON.stringify(data));
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ai_chats_save", { docPath, data });
}

export async function deleteChats(docPath: string): Promise<void> {
  if (!isTauri) {
    localStorage.removeItem(LOCAL_KEY(docPath));
    return;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("ai_chats_delete", { docPath }).catch(() => {});
}
