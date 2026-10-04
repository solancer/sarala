/**
 * AI assistant panel, docked on the right and opened from the rail
 * (AiRail.tsx).
 *
 * The agent never edits the document directly. Its edits arrive as change
 * cards (a word diff of the Markdown source) that the user accepts or rejects;
 * accepting goes through the store like any other edit, so it is one undo step.
 * All session logic lives in src/ai/session.ts; this file is presentation.
 *
 * The panel stays mounted so a conversation survives closing it. Opening takes
 * its space in one step and slides the contents in: animating the width would
 * re-wrap the editor text on every frame, which reads as jitter.
 */
import {
  For, Match, Show, Switch, createEffect, createMemo, createSignal, on, onCleanup, onMount,
} from "solid-js";
import { renderMarkdown } from "../markdown";
import { isMac, openExternal } from "../platform";
import { doc, fileName, stats } from "../store";
import {
  AGENTS, agentInfo, aiEnabled, aiModel, aiPanelOpen, aiPanelWidth, clampAiPanel,
  saveAiPanelWidth, setAiEnabled, setAiPanelOpen, setAiPanelWidth, statusEpoch,
} from "../ai/config";
import {
  acceptAll, acceptProposal, askAboutSelection, chatAgent, chooseAgent, closeChat, currentChat, docChats,
  ensureActiveChat, highlightBlocks, isApplicable, isRevertible, newChat, onFocusRequest, pendingCount,
  pendingProposals, rejectAll, rejectProposal, removeReference, revertProposal, renameChat, retry, revealBlock, reviewDocument, selectChat, send, stop,
  type ChatItem, type ChatState,
} from "../ai/session";
import { referenceLabel } from "../ai/document";
import { wordDiff } from "../ai/diff";
import type { AgentStatus } from "../ai/transport";
import { refreshAgents } from "../ai/availability";
import type { Proposal } from "../ai/proposals";
import type { AgentId } from "../ai/types";
import { AgentLogo, AgentMark, AiIcon } from "./AiIcons";
import { OutputLine, createLogin } from "./AiSettings";
import { AgentCards, InstallScreen } from "./AiAgents";
import {
  agentStatuses, agentsChecked, anyInstalled, bestAgent, checkingAgents, pickWorkingAgent, setSwitchNote, switchNote,
} from "../ai/availability";
import { openSettings } from "./SettingsModal";
import { VoiceButton } from "./VoiceHud";

/* ---------- small pieces ---------- */

/**
 * Rendered HTML of finished replies, so switching chats or reopening the panel
 * doesn't re-render a whole transcript. Small LRU; streaming text isn't cached.
 */
const htmlCache = new Map<string, string>();
function renderCached(text: string, cache: boolean): string {
  const hit = htmlCache.get(text);
  if (hit !== undefined) {
    htmlCache.delete(text);
    htmlCache.set(text, hit); // most recently used last
    return hit;
  }
  const html = renderMarkdown(text);
  if (cache) {
    htmlCache.set(text, html);
    if (htmlCache.size > 300) htmlCache.delete(htmlCache.keys().next().value!);
  }
  return html;
}

/** Assistant text rendered through the app's sanitized Markdown pipeline. */
function Markdown(props: { text: string; streaming?: boolean }) {
  const html = createMemo(() => renderCached(props.text, !props.streaming));
  return (
    <div
      class="ai-md"
      ref={(el) => createEffect(() => (el.innerHTML = html()))}
      onClick={(e) => {
        const a = (e.target as HTMLElement).closest("a");
        if (!a) return;
        e.preventDefault();
        const href = a.getAttribute("href") ?? "";
        if (/^https?:\/\//i.test(href)) void openExternal(href);
      }}
    />
  );
}

function Diff(props: { before: string; after: string }) {
  const parts = createMemo(() => wordDiff(props.before, props.after));
  return (
    <For each={parts()}>
      {(p) => (
        <Switch fallback={<span>{p.text}</span>}>
          <Match when={p.type === "add"}><ins>{p.text}</ins></Match>
          <Match when={p.type === "del"}><del>{p.text}</del></Match>
        </Switch>
      )}
    </For>
  );
}

type StatusTone = "ready" | "warn" | "off" | "unknown";

const VENDOR: Record<AgentId, string> = {
  "claude-code": "Anthropic", codex: "OpenAI", copilot: "GitHub", mock: "Development",
};

/** "codex-cli 0.158.0" / "2.1.285 (Claude Code)" → "v0.158.0". */
function versionOf(s: AgentStatus | null | undefined): string | null {
  const m = s?.version?.match(/\d+(?:\.\d+)+/);
  return m ? `v${m[0]}` : null;
}

/** Who it's signed in as, in plain words. */
function accountOf(agent: AgentId, s: AgentStatus | null | undefined): string | null {
  if (!s?.account || s.signedIn !== true) return null;
  if (agent === "codex") return /chatgpt/i.test(s.account) ? "ChatGPT account" : "API key";
  return s.account.replace(/\s*\(.*\)$/, "");
}

/** Status pill: what the agent needs before it can run. */
function statusPill(s: AgentStatus | null | undefined): { tone: StatusTone; label: string } {
  if (s === undefined) return { tone: "unknown", label: "Checking" };
  if (!s?.installed) return { tone: "off", label: "Install" };
  if (s.signedIn === false) return { tone: "warn", label: "Sign in" };
  return { tone: "ready", label: "Ready" };
}

/* ---------- header: agent switcher ---------- */

function AgentSwitcher(props: { status: AgentStatus | null | undefined }) {
  const [open, setOpen] = createSignal(false);
  let root: HTMLDivElement | undefined;
  let button: HTMLButtonElement | undefined;
  let menu: HTMLDivElement | undefined;
  const all = agentStatuses;
  const agent = () => chatAgent(currentChat());
  const items = () => [...(menu?.querySelectorAll<HTMLElement>("[role^=menuitem]") ?? [])];

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button?.focus();
  };
  const toggle = () => {
    if (open()) return close();
    setOpen(true);
    void refreshAgents();
    // Focus the current agent, as native menus do.
    requestAnimationFrame(() => (menu?.querySelector<HTMLElement>("[aria-checked=true]") ?? items()[0])?.focus());
  };
  const pick = (id: AgentId) => {
    const s = all()[id];
    if (s !== undefined && !s?.installed && id !== "mock") {
      // Nothing to switch to yet: show how to install it.
      close(false);
      openSettings("ai");
      return;
    }
    close();
    if (id !== agent()) chooseAgent(id);
  };
  const onMenuKey = (e: KeyboardEvent) => {
    const list = items();
    const i = list.indexOf(document.activeElement as HTMLElement);
    const go = (k: number) => { e.preventDefault(); list[(k + list.length) % list.length]?.focus(); };
    if (e.key === "ArrowDown") go(i + 1);
    else if (e.key === "ArrowUp") go(i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Tab") close(false);
  };

  onMount(() => {
    const onDown = (e: MouseEvent) => { if (open() && !root?.contains(e.target as Node)) close(false); };
    const onKey = (e: KeyboardEvent) => { if (open() && e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    });
  });

  const headerSub = () => {
    const pill = statusPill(props.status);
    const detail = aiModel() || versionOf(props.status);
    if (pill.tone === "ready") return detail ?? "Ready";
    return detail ? `${pill.label === "Install" ? "Not installed" : "Signed out"} · ${detail}` : pill.label;
  };

  return (
    <div class="ai-switch" ref={root}>
      <button
        ref={button} class="ai-switch-btn" aria-haspopup="menu" aria-expanded={open()} onClick={toggle}
        title="Choose agent" aria-label={`Agent: ${agentInfo(agent()).label}. Change agent`}
      >
        <AgentMark agent={agent()} />
        <span class="ai-switch-text">
          <span class="ai-switch-name">{agentInfo(agent()).label}<AiIcon name="chevron" class="ai-ic ai-switch-caret" /></span>
          <span class="ai-switch-sub">
            <i class="ai-dot" data-tone={statusPill(props.status).tone} />
            {headerSub()}
          </span>
        </span>
      </button>
      <Show when={open()}>
        <div class="ai-menu ai-agent-menu" role="menu" aria-label="Agent" ref={menu} onKeyDown={onMenuKey}>
          <div class="ai-menu-head" role="none">
            <span role="none">Choose an agent</span>
            <button class="ai-menu-refresh" role="menuitem" tabIndex={-1} title="Check again" aria-label="Check agents again" onClick={() => void refreshAgents(true)}>
              <AiIcon name="refresh" class={checkingAgents() ? "ai-ic spinning" : "ai-ic"} />
            </button>
          </div>
          <For each={AGENTS}>
            {(a) => {
              const s = () => all()[a.id];
              const pill = () => statusPill(s());
              const sub = () => [accountOf(a.id, s()) ?? VENDOR[a.id], versionOf(s())].filter(Boolean).join(" · ");
              return (
                <button
                  class="ai-agent-option" role="menuitemradio" aria-checked={a.id === agent()}
                  classList={{ current: a.id === agent(), missing: pill().tone === "off" }}
                  onClick={() => pick(a.id)}
                >
                  <AgentMark agent={a.id} />
                  <span class="ai-agent-option-text">
                    <span class="ai-agent-option-name">{a.label}</span>
                    <span class="ai-agent-option-sub">{sub()}</span>
                  </span>
                  <span class="ai-pill" data-tone={pill().tone}>
                    <Show when={pill().tone !== "unknown"} fallback={<span class="ai-spinner sm" aria-hidden="true" />}>
                      <i class="ai-dot" data-tone={pill().tone} />
                    </Show>
                    {pill().label}
                  </span>
                  <span class="ai-agent-option-check" aria-hidden="true">
                    <Show when={a.id === agent()}><AiIcon name="check" class="ai-ic" /></Show>
                  </span>
                </button>
              );
            }}
          </For>
          <Show when={currentChat()?.started}>
            <p class="ai-menu-note" role="none"><AiIcon name="chat" />This chat stays with {agentInfo(agent()).label}. Picking another agent starts a new chat.</p>
          </Show>
          <div class="ai-menu-sep" role="separator" />
          <button class="ai-menu-item plain" role="menuitem" onClick={() => { close(false); openSettings("ai"); }}>
            <AiIcon name="settings" /><span>Agent settings…</span>
          </button>
        </div>
      </Show>
    </div>
  );
}

/* ---------- banners and empty states ---------- */

/** Why the current chat can't send right now (with a way out), or null. */
function blockReason(): { text: string; action?: { label: string; run: () => void } } | null {
  if (!agentsChecked()) return null;
  const agent = chatAgent(currentChat());
  if (agent === "mock") return null;
  const s = agentStatuses()[agent];
  if (s === undefined) return null;
  const label = agentInfo(agent).label;
  if (!s?.installed) {
    const best = bestAgent(agentStatuses());
    return {
      text: `${label} isn't installed on this computer.`,
      action: best && best !== agent ? { label: `Use ${agentInfo(best).label}`, run: () => chooseAgent(best) } : undefined,
    };
  }
  if (s.signedIn === false) return { text: `Sign in to ${label} to start.` };
  return null;
}

/** Sign-in prompt above the conversation when the chat's agent is signed out. */
function SetupBanner() {
  const agent = () => chatAgent(currentChat());
  const login = createLogin(agent);
  const s = () => agentStatuses()[agent()];
  const show = () => agent() !== "mock" && !!s()?.installed && (s()!.signedIn === false || login.running() || !!login.error());
  return (
    <Show when={show()}>
      <div class="ai-banner" role="status">
        <AiIcon name="login" class="ai-ic ai-banner-ic" />
        <div class="ai-banner-body">
          <strong>{login.running() ? "Finish signing in in your browser…" : `Sign in to ${agentInfo(agent()).label}`}</strong>
          <Show when={!login.running()}>
            <span>It opens the provider's sign-in page. Sarala never sees your credentials.</span>
          </Show>
          <Show when={login.output().length}>
            <div class="ai-banner-output">
              <For each={login.output().slice(-3)}>{(line) => <OutputLine line={line} />}</For>
            </div>
          </Show>
          <Show when={login.error()}><span class="ai-banner-error">{login.error()}</span></Show>
        </div>
        <Show
          when={!login.running()}
          fallback={<button class="ghost-btn" onClick={login.cancel}>Cancel</button>}
        >
          <button class="ai-primary" onClick={() => void login.start()}>Sign in</button>
        </Show>
      </div>
    </Show>
  );
}

/** One-line note after the assistant moved to another agent on its own. */
function SwitchNote() {
  return (
    <Show when={switchNote()}>
      <div class="ai-note-strip" role="status">
        <AiIcon name="alert" />
        <span>{switchNote()}</span>
        <button class="ai-chip-x" aria-label="Dismiss" onClick={() => setSwitchNote(null)}><AiIcon name="x" /></button>
      </div>
    </Show>
  );
}

function Onboarding() {
  return (
    <div class="ai-hero">
      <div class="ai-orb" aria-hidden="true"><AiIcon name="sparkle" /></div>
      <h2 class="ai-hero-title">Write with an AI agent</h2>
      <p class="ai-hero-lede">Use Claude Code, Codex, or GitHub Copilot on this document.</p>
      <ul class="ai-features">
        <li><AiIcon name="chat" /><span><strong>Ask and review.</strong> Questions, summaries, and feedback on the whole document or a selection.</span></li>
        <li><AiIcon name="diff" /><span><strong>You approve every edit.</strong> Changes arrive as diffs to accept or reject; undo works as usual.</span></li>
        <li><AiIcon name="lock" /><span><strong>No keys stored.</strong> Runs the agent installed on this computer with its own sign-in, on a private copy of the file.</span></li>
      </ul>
      <h3 class="ai-section-title">Agents on this computer</h3>
      <AgentCards selectable />
      <button
        class="ai-primary ai-hero-cta"
        disabled={agentsChecked() && !anyInstalled()}
        onClick={() => { pickWorkingAgent(); void setAiEnabled(true); }}
      >
        Turn on the assistant
      </button>
      <Show when={agentsChecked() && !anyInstalled()}>
        <p class="ai-cta-reason">Install one of the agents above first. Sarala notices it automatically.</p>
      </Show>
    </div>
  );
}

const SUGGESTIONS: { icon: string; title: string; desc: string; run: () => void }[] = [
  { icon: "review", title: "Review", desc: "Find issues in clarity, structure and correctness", run: reviewDocument },
  { icon: "summary", title: "Summarize", desc: "Key points in a few bullets", run: () => void send("Summarize this document in a few bullet points. Don't edit it.", { display: "Summarize this document", refs: [] }) },
  { icon: "proof", title: "Proofread", desc: "Fix spelling, grammar and punctuation", run: () => void send("Proofread the whole document: fix spelling, grammar and punctuation only.", { display: "Proofread the document", refs: [] }) },
  { icon: "heading", title: "Headings", desc: "Make the title and headings clearer", run: () => void send("Make the title and headings clearer.", { display: "Improve the headings", refs: [] }) },
];

function Welcome() {
  return (
    <div class="ai-welcome">
      <div class="ai-welcome-mark"><AgentMark agent={chatAgent(currentChat())} /></div>
      <h2 class="ai-welcome-title">What should we work on?</h2>
      <p class="ai-welcome-sub">{agentInfo(chatAgent(currentChat())).label} can see “{fileName()}”.</p>
      <div class="ai-suggest">
        <For each={SUGGESTIONS}>
          {(s, i) => (
            <button class="ai-suggest-card" style={{ "--i": i() }} disabled={!!blockReason()} onClick={s.run}>
              <AiIcon name={s.icon} />
              <span class="ai-suggest-title">{s.title}</span>
              <span class="ai-suggest-desc">{s.desc}</span>
            </button>
          )}
        </For>
      </div>
      <p class="ai-welcome-hint">
        Tip: select text and press <span class="kbd">{isMac ? "⇧⌘I" : "Ctrl+Shift+I"}</span> to ask about it.
      </p>
    </div>
  );
}

/* ---------- transcript ---------- */

const STATUS: Record<Exclude<Proposal["status"], "pending">, { label: string; icon: string }> = {
  accepted: { label: "Accepted", icon: "check" },
  rejected: { label: "Rejected", icon: "x" },
  stale: { label: "Out of date", icon: "alert" },
};

/** After a decision, keep keyboard users in the review flow: the next pending
 *  card's Accept (after this one, else the first), else the message box. */
function focusAfterDecision(from: HTMLElement | null) {
  requestAnimationFrame(() => {
    const pending = [...document.querySelectorAll<HTMLElement>(".ai-proposal.is-pending")];
    const next = pending.find((el) => from && from.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) ?? pending[0];
    const target = next?.querySelector<HTMLElement>(".ai-primary:not(:disabled), .ai-secondary")
      ?? document.querySelector<HTMLElement>(".ai-input");
    target?.focus({ preventScroll: false });
  });
}

/** Scroll a card into view, focus it, and show its text in the editor. */
export function focusProposal(p: Proposal) {
  const el = document.querySelector<HTMLElement>(`.ai-proposal[data-proposal="${p.id}"]`);
  el?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  el?.querySelector<HTMLElement>(".ai-primary:not(:disabled), .ai-secondary")?.focus({ preventScroll: true });
  const id = p.kind === "edit" ? p.blockIds[0] : p.afterBlockId;
  if (id !== null && id !== undefined) revealBlock(id);
}

function ProposalCard(props: { p: Proposal }) {
  const p = () => props.p;
  const decided = () => p().status !== "pending";
  const [open, setOpen] = createSignal(true);
  const [long, setLong] = createSignal(false);
  const [expanded, setExpanded] = createSignal(false);
  const [view, setView] = createSignal<"changes" | "result">("changes");
  let bodyEl: HTMLDivElement | undefined;
  let cardEl: HTMLElement | undefined;

  // Collapse to a one-line summary once decided; the header re-opens it.
  createEffect(on(decided, (d) => { setOpen(!d); }, { defer: true }));
  onMount(() => requestAnimationFrame(() => setLong((bodyEl?.scrollHeight ?? 0) > 232)));

  // Checked live against the document: a card whose text was edited since
  // says so up front instead of failing on Accept.
  const applicable = createMemo(() => decided() || isApplicable(p()));
  const revertible = createMemo(() => p().status === "accepted" && isRevertible(p()));
  const original = () => (p().kind === "edit" ? (p() as Extract<Proposal, { kind: "edit" }>).original : "");
  const canToggle = () => !!original() && !!p().replacement;

  const blockIds = () => {
    const cur = p();
    if (cur.kind === "edit") return cur.blockIds;
    return cur.afterBlockId === null ? [] : [cur.afterBlockId];
  };
  const kind = () => (p().kind === "insert" ? "insert" : p().replacement ? "edit" : "trash");
  const computeTitle = () => {
    const cur = p();
    if (cur.kind === "insert") {
      if (cur.afterBlockId === null) return "Add at the start";
      const i = doc.blocks.findIndex((b) => b.id === cur.afterBlockId);
      return i < 0 ? "Add text" : `Add after block ${i + 1}`;
    }
    const found = doc.blocks.findIndex((b) => b.id === cur.blockIds[0]);
    // A restored, already-decided change has no live blocks: use where it was.
    const i = found >= 0 ? found : cur.at ?? -1;
    const where = i < 0 ? "" : cur.blockIds.length > 1 ? ` blocks ${i + 1}–${i + cur.blockIds.length}` : ` block ${i + 1}`;
    return `${cur.replacement ? "Edit" : "Delete"}${where}`;
  };
  // Keep the last located label: accepting replaces the blocks it points at,
  // so afterwards the position can no longer be computed.
  const title = createMemo<string>((prev) => {
    const next = computeTitle();
    return prev && (decided() || !/\d/.test(next)) ? prev : next;
  });

  const decide = (fn: (id: string) => void) => {
    fn(p().id);
    focusAfterDecision(cardEl ?? null);
  };

  return (
    <article
      ref={cardEl}
      class="ai-card ai-proposal ai-enter"
      data-proposal={p().id}
      aria-label={`${title()}${decided() ? `, ${STATUS[p().status as keyof typeof STATUS].label}` : ""}`}
      classList={{ [`is-${p().status}`]: true, decided: decided(), open: open(), stale: !applicable() }}
      onMouseEnter={() => highlightBlocks(blockIds())}
      onMouseLeave={() => highlightBlocks(null)}
    >
      <div class="ai-card-top">
        <button class="ai-card-head" disabled={!decided()} aria-expanded={decided() ? open() : undefined} onClick={() => setOpen(!open())}>
          <span class="ai-kind" data-kind={kind()}><AiIcon name={kind()} /></span>
          <span class="ai-card-title">{title()}</span>
          <Show when={decided()}>
            <span class="ai-state" data-state={p().status}>
              <AiIcon name={STATUS[p().status as keyof typeof STATUS].icon} />
              {STATUS[p().status as keyof typeof STATUS].label}
            </span>
            <AiIcon name="chevron" class="ai-ic ai-card-caret" />
          </Show>
        </button>
        <Show when={revertible()}>
          <button class="ai-revert" title="Put the original text back" onClick={() => revertProposal(p().id)}>
            <AiIcon name="undo" />Revert
          </button>
        </Show>
        <Show when={!decided() && canToggle()}>
          <div class="ai-view" role="group" aria-label="View">
            <button aria-pressed={view() === "changes"} classList={{ on: view() === "changes" }} onClick={() => setView("changes")}>Changes</button>
            <button aria-pressed={view() === "result"} classList={{ on: view() === "result" }} onClick={() => setView("result")}>Result</button>
          </div>
        </Show>
      </div>
      <div class="ai-collapse">
        <div class="ai-collapse-inner">
          <div class="ai-diff" classList={{ clipped: long() && !expanded(), result: view() === "result" }} ref={bodyEl}>
            <Show when={view() === "result"} fallback={<Diff before={original()} after={p().replacement} />}>
              {p().replacement}
            </Show>
          </div>
          <Show when={long()}>
            <button class="ai-more" onClick={() => setExpanded(!expanded())}>{expanded() ? "Show less" : "Show more"}</button>
          </Show>
          <Show when={!applicable()}>
            <p class="ai-stale-note"><AiIcon name="alert" />This text was edited after the agent proposed the change, so it can't be applied.</p>
          </Show>
          <div class="ai-card-actions">
            <Show when={blockIds().length}>
              <button class="ai-quiet" onClick={() => revealBlock(blockIds()[0])} title="Scroll to it in the document">
                <AiIcon name="target" />Show
              </button>
            </Show>
            <span class="ai-spacer" />
            <Show when={!decided()}>
              <Show
                when={applicable()}
                fallback={<button class="ai-secondary" onClick={() => decide(rejectProposal)}>Dismiss</button>}
              >
                <button class="ai-secondary" onClick={() => decide(rejectProposal)}>Reject</button>
                <button class="ai-primary" onClick={() => decide(acceptProposal)}><AiIcon name="check" />Accept</button>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </article>
  );
}

function Item(props: { item: ChatItem; prevUserId: string | null }) {
  const chat = () => currentChat();
  return (
    <Switch>
      <Match when={props.item.kind === "user" && props.item}>
        {(u) => (
          <div class="ai-msg ai-user ai-enter">
            <Show when={u().refs.length}>
              <div class="ai-chips">
                <For each={u().refs}>{(r) => <span class="ai-chip static"><AiIcon name="quote" />{referenceLabel(r)}</span>}</For>
              </div>
            </Show>
            <div class="ai-user-text">{u().text}</div>
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "assistant" && props.item}>
        {(a) => (
          <div class="ai-msg ai-assistant ai-enter" classList={{ streaming: a().streaming }} aria-busy={a().streaming}>
            <div class="ai-byline">
              <AgentMark agent={chatAgent(chat())} size="sm" />
              <span>{agentInfo(chatAgent(chat())).label}</span>
            </div>
            <Show when={a().text}><Markdown text={a().text} streaming={a().streaming} /></Show>
            <Show when={a().streaming && (a().activity || !a().text)}>
              <div class="ai-activity">
                <span class="ai-spinner" aria-hidden="true" />
                <span class="ai-shimmer">{a().activity ?? "Starting…"}</span>
              </div>
            </Show>
            <Show when={!a().streaming && a().ms !== undefined && !a().error}>
              <div class="ai-meta">
                <Show when={a().changes} fallback={<span>No changes to the document</span>}>
                  <span class="ai-meta-changes"><AiIcon name="diff" />{a().changes} change{a().changes === 1 ? "" : "s"} proposed</span>
                </Show>
                <span aria-hidden="true">·</span>
                <span>{(a().ms! / 1000).toFixed(a().ms! < 10_000 ? 1 : 0)} s</span>
              </div>
            </Show>
            <Show when={a().error}>
              <div class="ai-error" classList={{ soft: a().error === "Stopped." }} role={a().error === "Stopped." ? undefined : "alert"}>
                <AiIcon name={a().error === "Stopped." ? "stop" : "alert"} />
                <span class="ai-error-text">{a().error}</span>
                <Show when={props.prevUserId && a().error !== "Stopped."}>
                  <button class="ai-secondary" onClick={() => retry(props.prevUserId!)}>Retry</button>
                </Show>
              </div>
            </Show>
          </div>
        )}
      </Match>
      <Match when={props.item.kind === "proposal" && chat()?.proposals[props.item.id]}>
        {(p) => <ProposalCard p={p()} />}
      </Match>
      <Match when={props.item.kind === "notice" && props.item}>
        {(n) => <div class="ai-notice ai-enter">{n().text}</div>}
      </Match>
    </Switch>
  );
}

/* ---------- chat tabs ---------- */

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString();
}

function ChatTab(props: { c: ChatState; active: boolean; onRef: (el: HTMLElement) => void }) {
  const [editing, setEditing] = createSignal(false);
  const pending = () => pendingCount(props.c);
  let input: HTMLInputElement | undefined;
  const commit = () => {
    if (input) renameChat(props.c.id, input.value);
    setEditing(false);
  };
  return (
    <div
      class="ai-tab" role="listitem" ref={props.onRef}
      classList={{ active: props.active, busy: props.c.busy, unread: props.c.unread, editing: editing() }}
      onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeChat(props.c.id); } }}
    >
      <Show
        when={!editing()}
        fallback={
          <input
            ref={(el) => { input = el; queueMicrotask(() => { el.focus(); el.select(); }); }}
            class="ai-tab-input" value={props.c.title} aria-label="Chat name" maxLength={80}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.isComposing) return;
              if (e.key === "Enter") { e.preventDefault(); commit(); }
              if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setEditing(false); }
            }}
          />
        }
      >
        <button
          class="ai-tab-main" aria-current={props.active ? "true" : undefined} title={`${props.c.title} (double-click to rename)`}
          onClick={() => selectChat(props.c.id)}
          onDblClick={() => setEditing(true)}
        >
          <Show when={props.c.busy} fallback={<AgentLogo agent={chatAgent(props.c)} class="ai-ic ai-tab-ic" />}>
            <span class="ai-spinner sm" aria-label="Running" />
          </Show>
          <span class="ai-tab-title">{props.c.title}</span>
          <Show when={pending()}><span class="ai-tab-badge" aria-label={`${pending()} changes to review`}>{pending()}</span></Show>
          <Show when={props.c.unread && !pending()}><i class="ai-tab-dot" aria-label="New reply" /></Show>
        </button>
      </Show>
      <button class="ai-tab-x" aria-label={`Close ${props.c.title}`} title="Close chat" onClick={() => closeChat(props.c.id)}>
        <AiIcon name="x" />
      </button>
    </div>
  );
}

function ChatTabs() {
  const [menu, setMenu] = createSignal(false);
  const [ink, setInk] = createSignal({ left: 0, width: 0 });
  const els = new Map<string, HTMLElement>();
  let strip: HTMLDivElement | undefined;
  let root: HTMLDivElement | undefined;
  const chats = () => docChats();
  const activeId = () => currentChat()?.id;

  // Slide the active indicator under the active tab, and keep it in view.
  const place = () => {
    const el = activeId() ? els.get(activeId()!) : undefined;
    if (!el || !strip) return;
    setInk({ left: el.offsetLeft, width: el.offsetWidth });
    const { scrollLeft, clientWidth } = strip;
    if (el.offsetLeft < scrollLeft) strip.scrollTo({ left: el.offsetLeft - 8, behavior: "smooth" });
    else if (el.offsetLeft + el.offsetWidth > scrollLeft + clientWidth) {
      strip.scrollTo({ left: el.offsetLeft + el.offsetWidth - clientWidth + 8, behavior: "smooth" });
    }
  };
  createEffect(on(() => [activeId(), chats().map((c) => c.id + c.title + c.busy + pendingCount(c)).join()], () => requestAnimationFrame(place)));
  onMount(() => {
    const ro = new ResizeObserver(() => place());
    if (strip) ro.observe(strip);
    const onDown = (e: MouseEvent) => { if (menu() && !root?.contains(e.target as Node)) setMenu(false); };
    document.addEventListener("mousedown", onDown, true);
    onCleanup(() => { ro.disconnect(); document.removeEventListener("mousedown", onDown, true); });
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const list = chats();
    const i = list.findIndex((c) => c.id === activeId());
    const next = list[(i + (e.key === "ArrowRight" ? 1 : -1) + list.length) % list.length];
    if (!next) return;
    e.preventDefault();
    selectChat(next.id);
    requestAnimationFrame(() => els.get(next.id)?.querySelector<HTMLElement>(".ai-tab-main")?.focus());
  };

  return (
    <div class="ai-tabs" ref={root}>
      <div class="ai-tabs-strip" role="list" aria-label="Chats" ref={strip} onKeyDown={onKey}>
        <For each={chats()}>
          {(c) => <ChatTab c={c} active={c.id === activeId()} onRef={(el) => els.set(c.id, el)} />}
        </For>
        <span class="ai-tab-ink" aria-hidden="true" style={{ transform: `translateX(${ink().left}px)`, width: `${ink().width}px` }} />
      </div>
      <button class="ai-icon-btn ai-tabs-btn" data-tip="New chat" aria-label="New chat" onClick={newChat}>
        <AiIcon name="insert" />
      </button>
      <div class="ai-tabs-more">
        <button class="ai-icon-btn ai-tabs-btn" data-tip="All chats" aria-label="All chats" aria-haspopup="menu" aria-expanded={menu()} onClick={() => setMenu(!menu())}>
          <AiIcon name="chevron" />
        </button>
        <Show when={menu()}>
          <div class="ai-menu ai-chats-menu" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenu(false)}>
            <div class="ai-menu-head" role="none">Chats on this document</div>
            <For each={[...chats()].sort((a, b) => b.updatedAt - a.updatedAt)}>
              {(c) => (
                <div class="ai-chats-row" role="none" classList={{ on: c.id === activeId() }}>
                  <button class="ai-menu-item" role="menuitem" onClick={() => { selectChat(c.id); setMenu(false); }}>
                    <AgentMark agent={chatAgent(c)} size="sm" />
                    <span class="ai-menu-text">
                      <span class="ai-chats-title">{c.title}</span>
                      <span class="ai-menu-sub">
                        {c.busy ? "Running…" : (() => {
                          const n = c.items.filter((i) => i.kind === "user").length;
                          return `${n ? `${n} message${n === 1 ? "" : "s"}` : "Empty"} · ${ago(c.updatedAt)}`;
                        })()}
                        <Show when={pendingCount(c)}> · {pendingCount(c)} to review</Show>
                      </span>
                    </span>
                  </button>
                  <button class="ai-chats-del" role="menuitem" aria-label={`Delete ${c.title}`} title="Delete chat" onClick={() => closeChat(c.id)}>
                    <AiIcon name="trash" />
                  </button>
                </div>
              )}
            </For>
            <div class="ai-menu-sep" role="separator" />
            <button class="ai-menu-item plain" role="menuitem" onClick={() => { newChat(); setMenu(false); }}>
              <AiIcon name="insert" /><span>New chat</span>
            </button>
          </div>
        </Show>
      </div>
    </div>
  );
}

/* ---------- panel ---------- */

export default function AiPanel() {
  let listEl: HTMLDivElement | undefined;
  let inputEl: HTMLTextAreaElement | undefined;
  const [draft, setDraft] = createSignal("");
  const [atBottom, setAtBottom] = createSignal(true);
  const chat = () => currentChat();
  const busy = () => chat()?.busy ?? false;
  const items = () => chat()?.items ?? [];
  const pending = createMemo(() => pendingProposals().length);
  // Pending changes in document order, for the ‹ › navigator.
  const ordered = createMemo(() => {
    const pos = (p: Proposal) => {
      const id = p.kind === "edit" ? p.blockIds[0] : p.afterBlockId;
      const i = id === null ? -1 : doc.blocks.findIndex((b) => b.id === id);
      return i < 0 ? p.at ?? 0 : i;
    };
    return [...pendingProposals()].sort((a, b) => pos(a) - pos(b));
  });
  const [current, setCurrent] = createSignal<string | null>(null);
  const cursor = () => ordered().findIndex((p) => p.id === current());
  const step = (dir: 1 | -1) => {
    const list = ordered();
    if (!list.length) return;
    const i = cursor();
    const next = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length];
    setCurrent(next.id);
    focusProposal(next);
  };
  const status = () => agentStatuses()[chatAgent(currentChat())];
  const blocked = () => blockReason();
  // Screen readers get discrete announcements, not the streaming text: a live
  // region around the reply would stutter through every partial update.
  const [announcement, setAnnouncement] = createSignal("");
  createEffect(on(busy, (now, before) => {
    const label = agentInfo(chatAgent(chat())).label;
    if (now) return setAnnouncement(`${label} is working.`);
    if (!before) return;
    const last = [...items()].reverse().find((i) => i.kind === "assistant");
    if (last?.kind !== "assistant") return;
    const changes = last.changes ?? 0;
    setAnnouncement(last.error
      ? `${label}: ${last.error}`
      : `${label} replied${changes ? `, with ${changes} change${changes === 1 ? "" : "s"} to review` : ""}.`);
  }, { defer: true }));

  onMount(() => onFocusRequest(() => inputEl?.focus()));
  createEffect(() => { if (aiPanelOpen() && aiEnabled()) ensureActiveChat(); });
  // A different chat: start at its latest message.
  createEffect(on(() => chat()?.id, () => { setAtBottom(true); requestAnimationFrame(() => toBottom()); }, { defer: true }));
  onCleanup(() => onFocusRequest(null));
  // Re-check sign-in state each time the panel opens.
  createEffect(on(aiPanelOpen, (o) => { if (o) void statusEpoch(); }));

  // Follow the conversation while it grows, unless the user scrolled up.
  const onScroll = () => {
    if (!listEl) return;
    setAtBottom(listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight < 48);
  };
  const toBottom = (smooth = false) => {
    if (!listEl) return;
    listEl.scrollTo({ top: listEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  };
  createEffect(on(() => JSON.stringify(items().map((i) => (i.kind === "assistant" ? i.text.length + (i.activity ?? "") : i.id))) + (pending() > 1), () => {
    if (atBottom()) requestAnimationFrame(() => toBottom());
  }));

  const submit = () => {
    const text = draft().trim();
    if (!text || busy() || blocked()) return;
    setDraft("");
    if (inputEl) inputEl.style.height = "";
    setAtBottom(true);
    void send(text);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    // Never send mid-composition (CJK input confirms candidates with Enter).
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (busy()) stop();
      else setAiPanelOpen(false);
    }
  };

  const startResize = (e: PointerEvent) => {
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    const panel = handle.parentElement!;
    const right = panel.getBoundingClientRect().right;
    panel.classList.add("resizing");
    const onMove = (m: PointerEvent) => setAiPanelWidth(clampAiPanel(right - m.clientX));
    const onUp = () => {
      panel.classList.remove("resizing");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      void saveAiPanelWidth();
    };
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  };

  const prevUser = (index: number): string | null => {
    const list = items();
    for (let i = index - 1; i >= 0; i--) if (list[i].kind === "user") return list[i].id;
    return null;
  };

  return (
    <aside
      id="ai-panel"
      onKeyDown={(e) => {
        if (!e.altKey || (e.key !== "ArrowDown" && e.key !== "ArrowUp") || !pending()) return;
        e.preventDefault();
        step(e.key === "ArrowDown" ? 1 : -1);
      }}
      class="ai-panel"
      classList={{ open: aiPanelOpen() }}
      style={{ width: `${aiPanelWidth()}px` }}
      inert={!aiPanelOpen()}
      aria-hidden={!aiPanelOpen()}
      aria-label="AI assistant"
    >
      <div
        class="ai-resize" role="separator" aria-orientation="vertical" tabindex="0"
        aria-label="Resize assistant panel" aria-valuenow={aiPanelWidth()}
        onPointerDown={startResize}
        onKeyDown={(e) => {
          if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
          e.preventDefault();
          setAiPanelWidth(clampAiPanel(aiPanelWidth() + (e.key === "ArrowLeft" ? 20 : -20)));
          void saveAiPanelWidth();
        }}
      />
      <div class="ai-panel-inner">
        <header class="ai-head">
          <Show when={aiEnabled()} fallback={<span class="ai-head-title"><AiIcon name="sparkle" />Assistant</span>}>
            <AgentSwitcher status={status()} />
          </Show>
          <span class="ai-spacer" />
          <button class="ai-icon-btn" title="Close (Esc)" aria-label="Close assistant" onClick={() => setAiPanelOpen(false)}>
            <AiIcon name="close" />
          </button>
        </header>

        <Show when={aiEnabled()} fallback={<div class="ai-list scrollarea"><Onboarding /></div>}>
        <Show when={!agentsChecked() || anyInstalled()} fallback={<div class="ai-list scrollarea"><InstallScreen /></div>}>
          <ChatTabs />
          <SwitchNote />
          <div class="sr-only" role="status" aria-live="polite">{announcement()}</div>
          <SetupBanner />
          <div class="ai-list-wrap" classList={{ "has-bulk": pending() > 1 }}>
            <div class="ai-list scrollarea" ref={listEl} onScroll={onScroll} role="log" aria-label="Conversation" aria-live="off">
              <Show when={!items().length}><Welcome /></Show>
              <For each={items()}>{(item, i) => <Item item={item} prevUserId={prevUser(i())} />}</For>
            </div>
            <div class="ai-float">
              <Show when={!atBottom()}>
                <button class="ai-jump" aria-label="Jump to latest" onClick={() => { setAtBottom(true); toBottom(true); }}>
                  <AiIcon name="arrowDown" />
                </button>
              </Show>
              <Show when={pending() > 0}>
                <div class="ai-bulk" role="group" aria-label="Changes to review">
                  <button class="ai-nav-btn" aria-label="Previous change (Alt+Up)" title="Previous change (Alt+↑)" onClick={() => step(-1)}>
                    <AiIcon name="chevron" class="ai-ic ai-nav-up" />
                  </button>
                  <span class="ai-bulk-count" aria-live="off">
                    {cursor() >= 0 ? `${cursor() + 1} of ${pending()}` : `${pending()} to review`}
                  </span>
                  <button class="ai-nav-btn" aria-label="Next change (Alt+Down)" title="Next change (Alt+↓)" onClick={() => step(1)}>
                    <AiIcon name="chevron" />
                  </button>
                  <Show when={pending() > 1}>
                    <span class="ai-bulk-sep" aria-hidden="true" />
                    <button class="ai-secondary" onClick={rejectAll}>Reject all</button>
                    <button class="ai-primary" onClick={acceptAll}><AiIcon name="check" />Accept all</button>
                  </Show>
                </div>
              </Show>
            </div>
          </div>

          <div class="ai-compose">
            <Show when={blocked()}>
              {(b) => (
                <div class="ai-blocked" role="status">
                  <AiIcon name="alert" />
                  <span>{b().text}</span>
                  <Show when={b().action}>
                    {(a) => <button class="ai-secondary" onClick={a().run}>{a().label}</button>}
                  </Show>
                </div>
              )}
            </Show>
            <div class="ai-box" classList={{ busy: busy(), disabled: !!blocked() }}>
              <Show when={chat()?.refs.length}>
                <div class="ai-chips">
                  <For each={chat()!.refs}>
                    {(r) => (
                      <span class="ai-chip ai-enter">
                        <button class="ai-chip-label" title="Show in document" onClick={() => revealBlock(r.blockIds[0])}>
                          <AiIcon name="quote" />{referenceLabel(r)}
                        </button>
                        <button class="ai-chip-x" aria-label="Remove reference" onClick={() => removeReference(r.id)}>
                          <AiIcon name="x" />
                        </button>
                      </span>
                    )}
                  </For>
                </div>
              </Show>
              <textarea
                ref={inputEl}
                class="ai-input"
                rows={1}
                placeholder={chat()?.refs.length ? "Ask about the selection…" : `Ask ${agentInfo(chatAgent(chat())).label} about this document…`}
                aria-label="Message the assistant"
                disabled={!!blocked() && !busy()}
                value={draft()}
                onInput={(e) => {
                  setDraft(e.currentTarget.value);
                  e.currentTarget.style.height = "auto";
                  e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 200)}px`;
                }}
                onKeyDown={onKeyDown}
              />
              <div class="ai-box-bar">
                <button
                  class="ai-quiet" title="Attach the current selection"
                  onMouseDown={(e) => { e.preventDefault(); askAboutSelection(); }}
                >
                  <AiIcon name="quote" />Selection
                </button>
                <span class="ai-context" title="The agent sees this document">
                  {fileName()} · {stats().words.toLocaleString()} words
                </span>
                <span class="ai-spacer" />
                <VoiceButton />
                <Show
                  when={busy()}
                  fallback={
                    <button class="ai-send" aria-label="Send" title="Send (Enter)" disabled={!draft().trim() || !!blocked()} onClick={submit}>
                      <AiIcon name="arrowUp" />
                    </button>
                  }
                >
                  <button class="ai-send is-stop" aria-label="Stop" title="Stop (Esc)" onClick={stop}>
                    <AiIcon name="stop" />
                  </button>
                </Show>
              </div>
            </div>
            <p class="ai-foot">Changes are proposals. Nothing is applied until you accept it.</p>
          </div>
        </Show>
        </Show>
      </div>
    </aside>
  );
}
