/**
 * Shared types for the AI assistant.
 *
 * The assistant drives the user's own agent CLIs (see src-tauri/src/ai.rs).
 * Each CLI prints one JSON object per line; `AgentParser`s in agents.ts turn
 * those lines into the few events the panel cares about.
 */

import type { Reference } from "./document";
import type { Proposal } from "./proposals";

export type AgentId = "claude-code" | "codex" | "copilot" | "mock";

export type AgentEvent =
  | { kind: "text"; delta: string }
  /** What the agent is doing right now ("Editing the document"). */
  | { kind: "activity"; label: string }
  /** The CLI's conversation id, used to resume the session next turn. */
  | { kind: "session"; id: string }
  | { kind: "error"; message: string };

export interface AgentParser {
  feed(line: string): AgentEvent[];
}

export type ChatItem =
  | { kind: "user"; id: string; text: string; refs: Reference[]; prompt: string }
  | {
    kind: "assistant"; id: string; text: string; activity: string | null; streaming: boolean; error?: string;
    /** After the run: how long it took and what the agent did. */
    ms?: number; steps?: string[]; changes?: number;
  }
  | { kind: "proposal"; id: string }
  | { kind: "notice"; id: string; text: string };

export interface ChatState {
  id: string;
  /** Document tab the chat belongs to. */
  tab: number;
  title: string;
  /** True once the user renamed it (auto-titling stops). */
  renamed: boolean;
  /** Fixed once the first message is sent; until then it follows the default. */
  agent: AgentId;
  started: boolean;
  items: ChatItem[];
  proposals: Record<string, Proposal>;
  /** Chips waiting in the input box. */
  refs: Reference[];
  busy: boolean;
  /** Finished while in the background. */
  unread: boolean;
  /** Blocks the running agent was pointed at, for the editor shimmer. */
  working: number[];
  updatedAt: number;
}

