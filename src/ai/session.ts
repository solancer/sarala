/**
 * AI chats. Each document tab can have several conversations ("chats"); one
 * of them is active and shown in the panel.
 *
 * Every message runs the chat's agent CLI once on a working copy of the
 * document (see src-tauri/src/ai.rs). The CLI keeps the conversation itself;
 * we pass its session id back to resume it, so each chat has its own CLI
 * session and working copy, and chats can run at the same time. When a run
 * ends, the working copy is diffed against what was sent and every changed
 * region becomes a proposal. Proposals only touch the document when the user
 * accepts them, through the store's own edit functions, so undo, dirty
 * tracking and autosave behave exactly as for typed edits.
 *
 * Chats of saved documents persist across restarts (persist.ts), including
 * each chat's CLI session id, so a reopened chat resumes the agent's own
 * conversation. A chat's working copy lives in a folder named after the chat,
 * because the CLIs tie resumable sessions to the folder they ran in.
 */
import { batch, createEffect, createRoot } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  activeTabId, doc, fileName, getTabDocument, openTabs, setActive, spliceBlocks, spliceMany, targetBlockIndex,
} from "../store";
import { getActiveBlockApi } from "../commands";
import { selectedBlockRange } from "../blockselect";
import { splitBlocks } from "../markdown";
import { agentInfo, aiAgent, aiAgentPath, aiEnabled, aiModel, aiPanelOpen, setAiAgent, setAiPanelOpen } from "./config";
import { createParser } from "./agents";
import { serializeReferences, snapshotText, takeSnapshot, type Reference } from "./document";
import { diffBlocks, planBatch, resolveProposal, resolveRevert, type Placed, type Proposal } from "./proposals";
import { QUICK_ACTIONS, quickActionPrompt, REVIEW_PROMPT, turnPrompt, type QuickAction } from "./prompts";
import { deleteChats, forgetWorkspace, loadChats, runAgent, saveChats, type RunExit, type RunHandle } from "./transport";
import { fromSaved, toSaved, type SavedSession } from "./persist";
import { agentStatuses, agentsChecked, canRun } from "./availability";
import type { AgentId, ChatItem, ChatState } from "./types";

export type { ChatItem, ChatState } from "./types";

/** Non-reactive per-chat state. */
interface Runtime {
  workspaceId: string;
  /** The CLI's own conversation id, once it has reported one. */
  sessionId: string | null;
  /** Accept/reject outcomes to mention in the next message. */
  decisions: string[];
  handle: RunHandle | null;
}

const [chats, setChats] = createStore<Record<string, ChatState>>({});
/** Per document tab: chat ids in tab order, and the active one. */
const [order, setOrder] = createStore<Record<number, { ids: string[]; active: string }>>({});
const runtimes = new Map<string, Runtime>();
let seq = 0;
const uid = (prefix: string) => `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`;

/* ---------- chat list ---------- */

function makeChat(tab: number): string {
  const id = uid("c");
  setChats(id, {
    id, tab, title: "New chat", renamed: false, agent: aiAgent(), started: false,
    items: [], proposals: {}, refs: [], busy: false, unread: false, working: [], updatedAt: Date.now(),
  });
  return id;
}

/** The active chat of a document tab, created on first use. */
function activeChatId(tab: number): string {
  const o = order[tab];
  if (o && chats[o.active]) return o.active;
  const id = makeChat(tab);
  setOrder(tab, { ids: [...(o?.ids ?? []), id], active: id });
  return id;
}

/** Make sure the current document has a chat to show (the panel calls this). */
export function ensureActiveChat() {
  activeChatId(activeTabId());
}

export function currentChat(): ChatState | undefined {
  const o = order[activeTabId()];
  return o ? chats[o.active] : undefined;
}

/** Chats of the current document, in tab order. */
export function docChats(): ChatState[] {
  return (order[activeTabId()]?.ids ?? []).map((id) => chats[id]).filter(Boolean);
}

/** The agent a chat uses: its own once started, else the current default. */
export const chatAgent = (c: ChatState | undefined): AgentId => (c?.started ? c.agent : aiAgent());

export function selectChat(id: string) {
  const c = chats[id];
  if (!c) return;
  setOrder(c.tab, "active", id);
  setChats(id, "unread", false);
  scheduleSave(c.tab);
  requestInputFocus();
}

/** Open a fresh chat, or stay on the active one if it's still empty. */
export function newChat() {
  const tab = activeTabId();
  const cur = chats[activeChatId(tab)];
  if (cur && !cur.started && !cur.items.length) {
    requestInputFocus();
    return;
  }
  const id = makeChat(tab);
  setOrder(tab, (o) => ({ ids: [...(o?.ids ?? []), id], active: id }));
  setAiPanelOpen(true);
  requestInputFocus();
}

/** Stop a chat's run and drop its runtime; `forget` also deletes its working copy. */
function dropRuntime(id: string, forget = true) {
  const rt = runtimes.get(id);
  if (!rt) return;
  rt.handle?.cancel();
  if (forget) void forgetWorkspace(rt.workspaceId);
  runtimes.delete(id);
}

/** Close a chat (stopping it if it runs). The last chat is replaced by a fresh one. */
export function closeChat(id: string) {
  const c = chats[id];
  if (!c) return;
  const tab = c.tab;
  dropRuntime(id);
  const ids = order[tab]?.ids ?? [];
  const at = ids.indexOf(id);
  const rest = ids.filter((x) => x !== id);
  let active = order[tab]?.active ?? "";
  if (active === id) active = rest[Math.min(at, rest.length - 1)] ?? "";
  setChats(produce((s) => { delete s[id]; }));
  scheduleSave(tab);
  if (!rest.length) {
    const fresh = makeChat(tab);
    setOrder(tab, { ids: [fresh], active: fresh });
  } else {
    setOrder(tab, { ids: rest, active });
  }
}

export function renameChat(id: string, title: string) {
  const t = title.trim();
  if (!chats[id] || !t) return;
  setChats(id, { title: t.slice(0, 80), renamed: true });
  scheduleSave(chats[id].tab);
}

/**
 * Choose an agent from the panel. A chat that already started keeps its
 * agent, so picking another one opens a new chat with it.
 */
export function chooseAgent(agent: AgentId) {
  void setAiAgent(agent);
  const c = currentChat();
  if (c?.started && c.agent !== agent) newChat();
}

/* ---------- persistence ---------- */

/** The path each document tab's chats are saved under (null: untitled). */
const savedPath = new Map<number, string | null>();
const saveTimers = new Map<number, ReturnType<typeof setTimeout>>();

function sessionOf(id: string): SavedSession | null {
  const rt = runtimes.get(id);
  return rt ? { workspaceId: rt.workspaceId, sessionId: rt.sessionId, decisions: rt.decisions } : null;
}

const blocksOf = (tab: number) => (tab === activeTabId() ? doc.blocks : getTabDocument(tab)?.blocks ?? []);

/** Write a tab's chats now (no-op for untitled documents). */
function saveNow(tab: number, path = savedPath.get(tab)) {
  clearTimeout(saveTimers.get(tab));
  saveTimers.delete(tab);
  if (!path) return;
  const o = order[tab];
  const list = (o?.ids ?? []).map((id) => chats[id]).filter(Boolean);
  const data = toSaved(list, o?.active ?? null, sessionOf, blocksOf(tab));
  void (data.chats.length ? saveChats(path, data) : deleteChats(path)).catch(() => {});
}

function scheduleSave(tab: number) {
  if (!savedPath.get(tab)) return;
  clearTimeout(saveTimers.get(tab));
  saveTimers.set(tab, setTimeout(() => saveNow(tab), 600));
}

/** Install saved chats for a tab, keeping any chat that already has content. */
async function restore(tab: number, path: string) {
  const data = await loadChats(path).catch(() => null);
  if (savedPath.get(tab) !== path) return; // renamed or closed meanwhile
  const { active, chats: restored } = fromSaved(data, blocksOf(tab));
  if (!restored.length) return;
  const keep = (order[tab]?.ids ?? []).filter((id) => chats[id]?.items.length);
  for (const id of order[tab]?.ids ?? []) {
    if (!keep.includes(id)) setChats(produce((s) => { delete s[id]; }));
  }
  for (const { chat, session } of restored) {
    setChats(chat.id, { ...chat, tab });
    if (session) runtimes.set(chat.id, { ...session, handle: null });
  }
  const ids = [...restored.map((r) => r.chat.id), ...keep];
  const current = order[tab]?.active;
  setOrder(tab, { ids, active: current && keep.includes(current) ? current : active ?? ids[0] });
}

/** Write every pending save now (the window is closing). */
export function flushChatSaves() {
  for (const tab of [...saveTimers.keys()]) saveNow(tab);
}
if (typeof window !== "undefined") window.addEventListener("beforeunload", flushChatSaves);

// Follow document tabs: load chats when a saved document opens, move them
// along when it is renamed or saved under a new name, and on close save them
// and stop their runs (the working copies stay so the chats can resume).
createRoot(() => {
  createEffect(() => {
    const tabs = openTabs();
    const live = new Set(tabs.map((t) => t.id));
    for (const t of tabs) {
      const path = t.filePath ?? null;
      if (!savedPath.has(t.id)) {
        savedPath.set(t.id, path);
        if (path) void restore(t.id, path);
      } else if (savedPath.get(t.id) !== path) {
        const old = savedPath.get(t.id);
        savedPath.set(t.id, path);
        const hasChats = (order[t.id]?.ids ?? []).some((id) => chats[id]?.items.length);
        if (path && hasChats) {
          saveNow(t.id, path);
          if (old) void deleteChats(old);
        } else if (path) {
          void restore(t.id, path);
        }
      }
    }
    for (const key of Object.keys(order)) {
      const tab = Number(key);
      if (live.has(tab)) continue;
      saveNow(tab);
      savedPath.delete(tab);
      for (const id of order[tab].ids) {
        dropRuntime(id, false);
        setChats(produce((s) => { delete s[id]; }));
      }
      setOrder(produce((s) => { delete s[tab]; }));
    }
  });
});

/* ---------- references ---------- */

/** The user's current selection in the editor as a reference, if any. */
export function referenceFromSelection(): Reference | null {
  const range = selectedBlockRange();
  if (range) {
    const blocks = doc.blocks.slice(range.start, range.end + 1);
    return { id: uid("r"), blockIds: blocks.map((b) => b.id), quote: blocks.map((b) => b.text).join("\n\n") };
  }
  const i = doc.activeIndex >= 0 ? doc.activeIndex : targetBlockIndex();
  if (i < 0) return null;
  const block = doc.blocks[i];
  const off = doc.activeIndex >= 0 ? getActiveBlockApi()?.selectionOffsets() : null;
  const quote = off && off.end > off.start ? block.text.slice(off.start, off.end) : block.text;
  if (!quote.trim()) return null;
  return { id: uid("r"), blockIds: [block.id], quote };
}

export function addReference(ref: Reference) {
  const id = activeChatId(activeTabId());
  setChats(id, "refs", (refs) => [...refs, ref]);
}

export function removeReference(refId: string) {
  const c = currentChat();
  if (c) setChats(c.id, "refs", (refs) => refs.filter((r) => r.id !== refId));
}

/** "Ask AI" from the editor: attach the selection and open the panel. */
export function askAboutSelection() {
  const ref = referenceFromSelection();
  if (ref) addReference(ref);
  setAiPanelOpen(true);
  requestInputFocus();
}

/* ---------- input focus (the panel subscribes) ---------- */

let focusListener: (() => void) | null = null;
export function onFocusRequest(fn: (() => void) | null) { focusListener = fn; }
function requestInputFocus() { queueMicrotask(() => focusListener?.()); }

/* ---------- sending ---------- */

function pushItem(id: string, item: ChatItem) {
  setChats(id, "items", (items) => [...items, item]);
  setChats(id, "updatedAt", Date.now());
  scheduleSave(chats[id].tab);
}

function patchAssistant(id: string, itemId: string, patch: Partial<Extract<ChatItem, { kind: "assistant" }>>) {
  if (!chats[id]) return; // closed meanwhile
  setChats(id, "items", (it) => it.kind === "assistant" && it.id === itemId, patch);
}

const SIGN_IN_HINT = /(log ?in|sign ?in|auth|unauthori[sz]ed|credential|token|\b401\b)/i;

function describeFailure(agent: AgentId, exit: RunExit, parserError: string | null): string {
  const tail = exit.stderr?.trim().split("\n").filter(Boolean).slice(-3).join(" ") ?? "";
  let msg = parserError || tail || `${agentInfo(agent).label} exited with code ${exit.code ?? "?"}.`;
  if (SIGN_IN_HINT.test(msg)) msg += " You can sign in from Settings > AI.";
  return msg;
}

const titleFrom = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 42 ? `${flat.slice(0, 41)}…` : flat || "New chat";
};

export interface SendOptions {
  /** What the transcript shows instead of the full request (quick actions). */
  display?: string;
  /** References to attach; defaults to the chips in the input. */
  refs?: Reference[];
  /** Internal: this is the one automatic retry after a lost CLI session. */
  freshRetry?: boolean;
}

/** How the CLIs report a session id they no longer have. */
const LOST_SESSION = /(no (conversation|session|thread)|(session|thread|conversation)[^.]*not found|could not (find|resume)|unknown (session|thread))/i;

export async function send(request: string, opts: SendOptions = {}): Promise<void> {
  const tab = activeTabId();
  const id = activeChatId(tab);
  const chat = chats[id];
  if (chat.busy || !request.trim()) return;
  if (!aiEnabled()) {
    pushItem(id, { kind: "notice", id: uid("n"), text: "Turn on the AI assistant in Settings > AI first." });
    return;
  }
  const agent = chatAgent(chat);
  // Known not to run (not installed, signed out): don't create a doomed
  // message. The panel shows why and how to fix it.
  const status = agentStatuses()[agent];
  if (agent !== "mock" && agentsChecked() && status !== undefined && !canRun(status)) {
    setAiPanelOpen(true);
    return;
  }
  if (!chat.started) setChats(id, { started: true, agent });
  let rt = runtimes.get(id);
  if (!rt) {
    rt = { workspaceId: `w-${id}`, sessionId: null, decisions: [], handle: null };
    runtimes.set(id, rt);
  }

  const refs = opts.refs ?? chat.refs;
  const snap = takeSnapshot(doc.blocks);
  const decisions = rt.decisions;
  rt.decisions = [];
  const prompt = turnPrompt({
    name: fileName(),
    resumed: rt.sessionId !== null,
    decisions,
    selection: serializeReferences(refs, snap),
    request: request.trim(),
  });

  const shown = opts.display ?? request.trim();
  if (!chats[id].renamed && !chats[id].items.some((i) => i.kind === "user")) setChats(id, "title", titleFrom(shown));
  pushItem(id, { kind: "user", id: uid("u"), text: shown, refs: [...refs], prompt: request.trim() });
  if (!opts.refs) setChats(id, "refs", []);
  setChats(id, { busy: true, working: refs.flatMap((r) => r.blockIds) });
  const itemId = uid("a");
  pushItem(id, { kind: "assistant", id: itemId, text: "", activity: null, streaming: true });

  const parser = createParser(agent);
  let text = "";
  let parserError: string | null = null;
  // Stream text reaches the transcript at most once per frame: a CLI can
  // print hundreds of tiny deltas a second, and each update re-renders the
  // reply's Markdown.
  const started = performance.now();
  const steps: string[] = [];
  let painted = "";
  let frame = 0;
  const flush = () => {
    frame = 0;
    if (text !== painted) {
      painted = text;
      patchAssistant(id, itemId, { text, activity: null });
    }
  };
  const runtime = rt;
  const resumedSession = rt.sessionId;

  const finish = (exit: RunExit) => {
    cancelAnimationFrame(frame);
    flush();
    runtime.handle = null;
    if (!chats[id]) return; // chat closed while running
    setChats(id, { busy: false, working: [], updatedAt: Date.now() });
    const inBackground = order[tab]?.active !== id || activeTabId() !== tab || !aiPanelOpen();
    if (inBackground) setChats(id, "unread", true);
    if (exit.cancelled) {
      runtime.decisions = [...decisions, ...runtime.decisions];
      patchAssistant(id, itemId, { streaming: false, activity: null, error: "Stopped." });
      return;
    }
    // The working copy is authoritative for edits; the stream is just the chat.
    let proposals: Proposal[] = [];
    if (exit.document !== null && exit.document.replace(/\r\n/g, "\n").trim() !== snapshotText(snap).trim()) {
      proposals = diffBlocks(snap.blocks, splitBlocks(exit.document), () => uid("p"));
    }
    const failed = parserError !== null || (exit.code !== 0 && exit.code !== null);
    // The CLI no longer has the session this chat resumes (deleted, or from
    // another machine): start a fresh one once, transparently.
    const why = `${parserError ?? ""} ${exit.stderr ?? ""}`;
    if (failed && resumedSession && !text && !proposals.length && !opts.freshRetry && LOST_SESSION.test(why)) {
      runtime.sessionId = null;
      runtime.decisions = [...decisions, ...runtime.decisions];
      const userIndex = chats[id].items.findIndex((i) => i.kind === "assistant" && i.id === itemId) - 1;
      setChats(id, "items", (items) => items.slice(0, Math.max(0, userIndex)));
      pushItem(id, { kind: "notice", id: uid("n"), text: `The earlier ${agentInfo(agent).label} session wasn't available, so this continues in a fresh one.` });
      void send(request, { ...opts, display: shown, refs, freshRetry: true });
      return;
    }
    patchAssistant(id, itemId, {
      streaming: false,
      activity: null,
      error: failed && !proposals.length ? describeFailure(agent, exit, parserError) : undefined,
      ms: Math.round(performance.now() - started),
      steps: [...new Set(steps)],
      changes: proposals.length,
    });
    if (failed && !proposals.length && !text) runtime.decisions = [...decisions, ...runtime.decisions];
    for (const p of proposals) {
      setChats(id, "proposals", p.id, p);
      pushItem(id, { kind: "proposal", id: p.id });
    }
    scheduleSave(tab);
  };

  try {
    rt.handle = await runAgent({
      agent,
      path: aiAgentPath(),
      workspaceId: rt.workspaceId,
      document: snapshotText(snap),
      prompt,
      sessionId: rt.sessionId,
      model: aiModel(),
    }, {
      onLine: (line) => {
        for (const ev of parser.feed(line)) {
          if (ev.kind === "text") {
            text += ev.delta;
            if (!frame) frame = requestAnimationFrame(flush);
          } else if (ev.kind === "activity") {
            const step = ev.label.replace(/…$/, "");
            if (steps[steps.length - 1] !== step) steps.push(step);
            patchAssistant(id, itemId, { activity: ev.label });
          } else if (ev.kind === "session") {
            if (runtime.sessionId !== ev.id) {
              runtime.sessionId = ev.id;
              scheduleSave(tab);
            }
          } else if (ev.kind === "error") {
            parserError = ev.message;
          }
        }
      },
      onExit: finish,
    });
  } catch (e) {
    finish({ code: -1, document: null, stderr: null, cancelled: false });
    patchAssistant(id, itemId, { error: String(e instanceof Error ? e.message : e) });
  }
}

export function stop() {
  const c = currentChat();
  if (c) runtimes.get(c.id)?.handle?.cancel();
}

/** Re-send a message whose run failed. */
export function retry(userItemId: string) {
  const chat = currentChat();
  if (!chat || chat.busy) return;
  const index = chat.items.findIndex((it) => it.id === userItemId);
  const item = chat.items[index];
  if (!item || item.kind !== "user") return;
  setChats(chat.id, "items", (items) => items.slice(0, index));
  void send(item.prompt, { display: item.text, refs: item.refs });
}

/* ---------- proposals ---------- */

/** The chat (of the current document) that owns a proposal. */
function ownerOf(proposalId: string): ChatState | undefined {
  return docChats().find((c) => proposalId in c.proposals);
}

function decide(chatId: string, id: string, status: "accepted" | "rejected" | "stale" | "pending", note: string) {
  setChats(chatId, "proposals", id, "status", status);
  runtimes.get(chatId)?.decisions.push(`the user ${note} one of your changes`);
  scheduleSave(chats[chatId].tab);
}

const replacementBlocks = (text: string) => (text.trim() ? splitBlocks(text) : []);

/** Splice a proposal in and return the ids of the blocks it produced. */
function applyAt(start: number, deleteCount: number, p: Proposal): number[] {
  return spliceBlocks(start, deleteCount, replacementBlocks(p.replacement));
}

/** Let freshly applied blocks glow briefly, so the change is easy to spot. */
function flashApplied(ids: number[], scroll: boolean) {
  requestAnimationFrame(() => {
    const all = document.querySelectorAll<HTMLElement>(".editor .page > .block");
    const els = ids.map((id) => all[doc.blocks.findIndex((b) => b.id === id)]).filter(Boolean);
    for (const el of els) {
      el.classList.remove("ai-applied");
      void el.offsetWidth; // restart the animation
      el.classList.add("ai-applied");
      setTimeout(() => el.classList.remove("ai-applied"), 1800);
    }
    if (scroll && els[0]) {
      const r = els[0].getBoundingClientRect();
      if (r.top < 60 || r.bottom > window.innerHeight - 40) els[0].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  });
}

export function acceptProposal(id: string) {
  const owner = ownerOf(id);
  const p = owner?.proposals[id];
  if (!owner || !p || p.status !== "pending") return;
  const r = resolveProposal(p, doc.blocks);
  if (!r.ok) return decide(owner.id, id, "stale", "could not apply (the text had changed)");
  const afterId = r.start > 0 ? doc.blocks[r.start - 1].id : null;
  const ids = applyAt(r.start, r.deleteCount, p);
  setChats(owner.id, "proposals", id, "applied", { ids, afterId });
  decide(owner.id, id, "accepted", "accepted");
  flashApplied(ids, true);
}

/** Can this pending proposal still be applied to the document as it is now? */
export function isApplicable(p: Proposal): boolean {
  return resolveProposal(p, doc.blocks).ok;
}

/** Can this accepted proposal still be reverted? */
export function isRevertible(p: Proposal): boolean {
  return resolveRevert(p, doc.blocks).ok;
}

/** Undo one accepted change: put the original text back, and offer it again. */
export function revertProposal(id: string) {
  const owner = ownerOf(id);
  const p = owner?.proposals[id];
  if (!owner || !p) return;
  const r = resolveRevert(p, doc.blocks);
  if (!r.ok) return;
  const original = p.kind === "edit" ? p.original : "";
  const ids = spliceBlocks(r.start, r.deleteCount, replacementBlocks(original));
  batch(() => {
    if (p.kind === "edit") setChats(owner.id, "proposals", id, (cur) => ({ ...cur, blockIds: ids }) as Proposal);
    setChats(owner.id, "proposals", id, "applied", undefined);
    decide(owner.id, id, "pending", "reverted");
  });
  flashApplied(ids, true);
}

export function rejectProposal(id: string) {
  const owner = ownerOf(id);
  const p = owner?.proposals[id];
  if (!owner || !p || p.status !== "pending") return;
  decide(owner.id, id, "rejected", "rejected");
}

const pendingOf = (c: ChatState | undefined) => (c ? Object.values(c.proposals).filter((p) => p.status === "pending") : []);

/** Pending proposals of the active chat. */
export function pendingProposals(): Proposal[] {
  return pendingOf(currentChat());
}

/** Pending proposals of every chat on the current document. */
export function docPendingProposals(): Proposal[] {
  return docChats().flatMap(pendingOf);
}

export const pendingCount = (c: ChatState) => pendingOf(c).length;

/** Whether any chat on the current document is running. */
export const docBusy = () => docChats().some((c) => c.busy);

/** Blocks any running chat on the current document is working on. */
export function workingBlockIds(): number[] {
  return docChats().flatMap((c) => (c.busy ? c.working : []));
}

/** Accept every pending proposal of the active chat as one undo step. */
export function acceptAll() {
  const chat = currentChat();
  if (!chat) return;
  const ready: Placed<Proposal>[] = [];
  for (const p of pendingProposals()) {
    const r = resolveProposal(p, doc.blocks);
    if (r.ok) ready.push({ item: p, start: r.start, deleteCount: r.deleteCount });
    else decide(chat.id, p.id, "stale", "could not apply (the text had changed)");
  }
  const { apply, conflicts } = planBatch(ready);
  if (!apply.length) {
    batch(() => { for (const p of conflicts) decide(chat.id, p.id, "stale", "could not apply (it overlapped another change)"); });
    return;
  }
  // One store update and one undo step for the whole set. Ops run highest
  // position first, so each op's preceding block is still the one seen now.
  const afterIds = apply.map(({ start }) => (start > 0 ? doc.blocks[start - 1].id : null));
  const created = spliceMany(apply.map(({ item, start, deleteCount }) => ({
    start, deleteCount, texts: replacementBlocks(item.replacement),
  })));
  batch(() => {
    for (const p of conflicts) decide(chat.id, p.id, "stale", "could not apply (it overlapped another change)");
    apply.forEach(({ item }, k) => {
      setChats(chat.id, "proposals", item.id, "applied", { ids: created[k], afterId: afterIds[k] });
      decide(chat.id, item.id, "accepted", "accepted");
    });
  });
  flashApplied(created.flat(), false);
}

export function rejectAll() {
  const chat = currentChat();
  if (!chat) return;
  for (const p of pendingProposals()) decide(chat.id, p.id, "rejected", "rejected");
}

/** Outline blocks in the editor while a change card is hovered (null clears). */
export function highlightBlocks(ids: number[] | null) {
  for (const el of document.querySelectorAll(".editor .page > .block.ai-target")) el.classList.remove("ai-target");
  if (!ids?.length) return;
  const all = document.querySelectorAll<HTMLElement>(".editor .page > .block");
  for (const id of ids) {
    const i = doc.blocks.findIndex((b) => b.id === id);
    if (i >= 0) all[i]?.classList.add("ai-target");
  }
}

/** Scroll the editor to a block and flash it. */
export function revealBlock(blockId: number) {
  const index = doc.blocks.findIndex((b) => b.id === blockId);
  if (index < 0) return;
  setActive(-1);
  requestAnimationFrame(() => {
    const el = document.querySelectorAll<HTMLElement>(".editor .page > .block")[index];
    const scroller = document.querySelector<HTMLElement>(".main .scroll");
    if (!el || !scroller) return;
    const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop - 48;
    scroller.scrollTo({ top: Math.max(0, top) });
    el.classList.remove("ai-flash");
    void el.offsetWidth; // restart the animation
    el.classList.add("ai-flash");
    setTimeout(() => el.classList.remove("ai-flash"), 1400);
  });
}

/* ---------- commands ---------- */

/** Quick actions and reviews start in the active chat unless it is busy. */
function freeChat() {
  if (currentChat()?.busy) newChat();
}

export function runQuickAction(action: QuickAction) {
  const ref = referenceFromSelection();
  setAiPanelOpen(true);
  if (!ref) {
    pushItem(activeChatId(activeTabId()), { kind: "notice", id: uid("n"), text: "Select some text first." });
    return;
  }
  freeChat();
  const label = QUICK_ACTIONS.find((a) => a.id === action)?.label ?? action;
  void send(quickActionPrompt(action), { display: label, refs: [ref] });
}

export function reviewDocument() {
  setAiPanelOpen(true);
  freeChat();
  void send(REVIEW_PROMPT, { display: "Review this document", refs: [] });
}
