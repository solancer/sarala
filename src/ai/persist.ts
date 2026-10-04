/**
 * Saving and restoring a document's chats.
 *
 * Chats are saved per document path (src-tauri/src/ai.rs `ai_chats_*`, in the
 * app data folder) with each chat's CLI session id, so a chat reopened after
 * a restart resumes the agent's own conversation. What doesn't survive a
 * restart is fixed up on load:
 *
 * - editor block ids are per-session, so pending proposals are re-found by
 *   their text (`reanchor`) or marked out of date;
 * - a run that was going when Sarala closed is shown as interrupted.
 *
 * The (de)serializers are pure and unit-tested (tests/ai.test.mjs).
 */
import type { SnapshotBlock } from "./document";
import { reanchor, type Proposal } from "./proposals";
import type { AgentId, ChatItem, ChatState } from "./types";

export const SAVE_VERSION = 1;

export interface SavedSession {
  workspaceId: string;
  sessionId: string | null;
  decisions: string[];
}

export interface SavedChat {
  id: string;
  title: string;
  renamed: boolean;
  agent: AgentId;
  started: boolean;
  unread: boolean;
  updatedAt: number;
  items: ChatItem[];
  proposals: Proposal[];
  session: SavedSession | null;
}

export interface SavedChats {
  version: number;
  active: string | null;
  chats: SavedChat[];
}

/** Only chats with something in them are worth keeping. */
const worthSaving = (c: ChatState) => c.items.some((i) => i.kind === "user");

export function toSaved(
  chats: readonly ChatState[],
  active: string | null,
  sessions: (id: string) => SavedSession | null,
  blocks: readonly SnapshotBlock[],
): SavedChats {
  const textOf = new Map(blocks.map((b) => [b.id, b.text]));
  const saved = chats.filter(worthSaving).map((c): SavedChat => ({
    id: c.id,
    title: c.title,
    renamed: c.renamed,
    agent: c.agent,
    started: c.started,
    unread: c.unread,
    updatedAt: c.updatedAt,
    items: c.items.map((i) => ({ ...i })),
    proposals: Object.values(c.proposals).map((p) => {
      // Refresh the insert anchor from the live document while ids still work.
      if (p.kind === "insert" && p.status === "pending" && p.afterBlockId !== null) {
        const anchorText = textOf.get(p.afterBlockId);
        if (anchorText !== undefined) return { ...p, anchorText };
      }
      return { ...p };
    }),
    session: sessions(c.id),
  }));
  return {
    version: SAVE_VERSION,
    active: saved.some((c) => c.id === active) ? active : saved[0]?.id ?? null,
    chats: saved,
  };
}

export interface Restored {
  chat: Omit<ChatState, "tab">;
  session: SavedSession | null;
}

/** Rebuild chats from a save against the document as it is now. */
export function fromSaved(data: unknown, blocks: readonly SnapshotBlock[]): { active: string | null; chats: Restored[] } {
  const saved = data as Partial<SavedChats> | null;
  if (!saved || saved.version !== SAVE_VERSION || !Array.isArray(saved.chats)) return { active: null, chats: [] };
  const chats = saved.chats.map((c): Restored => {
    const items = (c.items ?? []).map((i): ChatItem =>
      i.kind === "assistant" && i.streaming
        ? { ...i, streaming: false, activity: null, error: i.error ?? "Interrupted when Sarala closed." }
        : i);
    const proposals: Record<string, Proposal> = {};
    for (const p of c.proposals ?? []) {
      if (p.status !== "pending") {
        // Block ids are per-session: an old accept can't be reverted after a restart.
        proposals[p.id] = { ...p, applied: undefined };
        continue;
      }
      proposals[p.id] = reanchor(p, blocks) ?? { ...p, status: "stale" };
    }
    return {
      chat: {
        id: c.id, title: c.title, renamed: !!c.renamed, agent: c.agent, started: !!c.started,
        items, proposals, refs: [], busy: false, unread: !!c.unread, working: [], updatedAt: c.updatedAt ?? Date.now(),
      },
      session: c.session ?? null,
    };
  });
  const active = chats.some((c) => c.chat.id === saved.active) ? saved.active! : chats[0]?.chat.id ?? null;
  return { active, chats };
}
