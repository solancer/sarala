# AI Assistant Integration Plan

Status: **Phase 1 implemented** on branch `feat/ai-assistant`, **CLI-only**. The assistant runs the user's own Claude Code, OpenAI Codex, or GitHub Copilot CLI; Sarala stores no API keys or tokens. Sections 4 and 5 below describe the earlier API-key design and are kept for context; **section 16 is the current design**. Phases 2 and 3 are still proposals.
Scope: add an in-app AI assistant (Claude, OpenAI and OpenAI-compatible, GitHub Copilot) that can chat about the open document, take selected text as a reference, and propose edits the user reviews and accepts.

---

## 1. Goals and non-goals

### Goals

- Chat with an AI about the **current document**, with the document supplied as context.
- **Reference selections**: select text (in one block or across blocks) and attach it to the chat as a quoted reference.
- **Review, update, edit**: the AI proposes concrete edits; the user sees a diff and accepts or rejects each one. Accepted edits are undoable like any other edit.
- **Quick actions** on a selection: Improve, Shorten, Fix grammar, Change tone, Continue writing.
- **Document review mode**: the AI returns a list of review comments anchored to blocks.
- **Multiple providers**: Anthropic (Claude), OpenAI, any OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter, Azure OpenAI), and GitHub Copilot / GitHub Models.
- **Private by default**: the feature is off until enabled, and nothing is sent without an explicit user action.

### Non-goals (for the first iterations)

- Autonomous background edits or "ghost text" autocomplete while typing.
- Realtime collaboration or shared chat sessions.
- Bundling or running local models inside the app (users point the OpenAI-compatible adapter at their own local server instead).
- Changing the Markdown render pipeline in any way.

---

## 2. Constraints from the existing codebase

These are hard rules the design must respect (see `CLAUDE.local.md`):

| Constraint | Consequence for the AI feature |
|---|---|
| **Block invariant**: a styled block's `textContent` is byte-identical to its Markdown source; caret save/restore works by text offset (`src/livesource.ts`). | The AI never touches the DOM. All edits are applied to **Markdown source text** through store functions. |
| **Single render pipeline**: `renderMarkdown()` (`src/markdown.ts`) serves both the editor and HTML export. | No AI-specific rendering path. Diff previews render source text, or reuse `renderMarkdown()` read-only. |
| **Saves are atomic** (temp file + rename) in `src-tauri/src/main.rs`. | Any new on-disk writes (e.g. persisted chat history) use the same pattern. |
| **IME-safe editing**: composition events must be respected for CJK input. | The chat input must not send on Enter while `event.isComposing` is true. New editor key handlers must follow the same rule. |
| **pnpm dev runs in the browser** with an in-memory demo doc. | The provider layer needs a dev-only browser fallback so the UI can be iterated without `pnpm tauri dev`. |
| **No HTTP crates today**: the Rust side shells out to `curl` (see `download_pandoc`). | Streaming chat is the justified exception: add `reqwest` (see section 4.2). |

---

## 3. Existing hooks we build on

| Need | Existing code | Notes |
|---|---|---|
| Full document as Markdown | `fullText` memo, `src/store.ts:197` | Joins all block sources. This is exactly what the model sees. |
| Document outline | `outline` memo, `src/store.ts:211` | Used to trim context for long documents. |
| Replace a block range | `replaceBlocks(start, end, text)`, `src/store.ts:518` | Already calls `pushHistory()`, so an accepted edit is a single undo step. |
| Replace whole document | `replaceAll(text)`, `src/store.ts:563` | Uses `reconcileBlocks()` to keep ids of unchanged blocks, which preserves the render cache on large rewrites. |
| Edit one block | `updateBlock(index, text)`, `src/store.ts:401` | |
| Undo history | `pushHistory()`, `src/store.ts:284` | Needs a small "batch" extension for Accept all (section 6.4). |
| Active block selection offsets | `BlockApi.selectionOffsets()`, `src/commands.ts:85` via `getActiveBlockApi()` | Source offsets inside the active block. |
| Cross-block selection | `selectedBlockRange()`, `src/blockselect.ts` | Inclusive block range when a selection spans blocks. |
| Per-tab state | `DocumentTab` record, `src/store.ts:585` | Chat sessions are stored per tab alongside undo/redo. |
| Floating selection UI | `src/components/SelectionToolbar.tsx` | Add "Ask AI" and quick actions. |
| Context menu | `src/components/EditorContextMenu.tsx` | Add "Ask AI about selection", "Rewrite selection…". |
| Commands / palette / menus | `src/commands.ts`, `src/components/CommandPalette.tsx`, `src/menudata.ts`, `src-tauri/src/menu.rs` | Register `ai.*` commands once; they surface everywhere. |
| Slash menu | `src/slashactions.ts`, `src/slashmenu.ts` | `/ai` entry for "continue writing" / "draft section". |
| Settings | `src/settings.ts` (`getSetting`, `persist`), `src/components/SettingsModal.tsx` (`SECTIONS()` row model) | New "AI" section built from existing row kinds. |
| Event streaming from Rust | `download_pandoc` emits `pandoc-download` progress events | Same pattern for `ai-stream` token events. |
| Managed Rust state | `FileWatcher` in `tauri::State`, `src-tauri/src/main.rs:858` | Same pattern for in-flight request cancellation handles. |
| Component shell | `ModalFrame.tsx`, `modalFocus.ts`, `Sidebar.tsx` resize logic | Reuse for the AI panel and its resize handle. |

---

## 4. Architecture

```
┌──────────────────────────── Webview (SolidJS) ─────────────────────────────┐
│                                                                             │
│  SelectionToolbar / ContextMenu / Slash / Palette                           │
│          │  "Ask AI", quick actions                                         │
│          ▼                                                                  │
│  AiPanel.tsx ── chat UI, reference chips, proposal cards                    │
│          │                                                                  │
│          ▼                                                                  │
│  src/ai/session.ts ── per-tab sessions, prompt building, tool-call parsing  │
│          │                                  │                               │
│          ▼                                  ▼                               │
│  src/ai/client.ts                    src/ai/apply.ts                        │
│   (invoke + listen, or dev fetch)     (validate + replaceBlocks/updateBlock)│
│          │                                                                  │
└──────────┼──────────────────────────────────────────────────────────────────┘
           │ invoke("ai_chat") / listen("ai-stream") / invoke("ai_cancel")
┌──────────▼──────────────────────── Rust (Tauri) ────────────────────────────┐
│  src-tauri/src/ai/mod.rs     commands: ai_chat, ai_cancel, ai_set_key,      │
│                              ai_has_key, ai_delete_key, ai_list_models      │
│  src-tauri/src/ai/anthropic.rs   Messages API + SSE                          │
│  src-tauri/src/ai/openai.rs      Chat Completions/Responses + SSE            │
│  src-tauri/src/ai/github.rs      GitHub Models / Copilot auth                │
│  keyring (OS keychain)  ·  reqwest (HTTPS, streaming)                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Why the provider layer lives in Rust

Rust/Tauri background for this decision:

- **Keys never enter JavaScript.** Settings persist through `save_settings` into a plaintext JSON file in the app-data dir, which is not appropriate for API keys. Instead, keys go into the **OS keychain** via the `keyring` crate (macOS Keychain, Windows Credential Manager, Linux Secret Service). The frontend calls `ai_set_key(provider, key)` once; afterwards it can only ask `ai_has_key(provider) -> bool`. When `ai_chat` runs, Rust reads the key from the keychain itself, so the key never travels back across IPC.
- **CSP is `null`** (`tauri.conf.json`). Documents can contain HTML embeds and diagrams rendered in the same JS context. Keeping secrets out of that context limits the blast radius of any injection bug.
- **Streaming and cancellation are cleaner.** A Tauri command can be `async fn`; it runs on Tauri's async runtime (tokio), so an HTTP stream does not block the UI thread. (`download_pandoc` uses `spawn_blocking` only because its work is synchronous `std::process::Command` calls; an async HTTP client does not need that.)
- **Custom commands need no capability entries.** Commands registered in `invoke_handler![...]` are callable from the main window without changes to `capabilities/default.json`; that file gates *plugin* permissions only. No new plugin permissions are required by this design.

### 4.2 New Rust dependencies

```toml
reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls"] }
keyring = { version = "3", features = ["apple-native", "windows-native", "sync-secret-service"] }
futures-util = "0.3"   # iterate the byte stream
eventsource-stream = "0.2"   # SSE parsing (or a ~40 line hand-rolled parser)
tokio-util = "0.7"   # CancellationToken
```

`rustls-tls` avoids a dependency on system OpenSSL on Linux, which matters for the snap build. Verify the Linux keychain backend works inside the snap sandbox (it needs the `password-manager-service` plug); if it does not, fall back to an encrypted file with a clear warning in Settings.

### 4.3 Rust command surface

```rust
#[derive(Deserialize)]
pub struct AiRequest {
    request_id: String,
    provider: Provider,          // "anthropic" | "openai" | "github"
    model: String,
    base_url: Option<String>,    // OpenAI-compatible override (Ollama, Azure, ...)
    system: String,
    messages: Vec<AiMessage>,    // role + content parts
    tools: Vec<ToolDef>,         // JSON-schema tool definitions
    max_tokens: u32,
}

#[tauri::command]
async fn ai_chat(app: AppHandle, state: State<'_, AiRequests>, req: AiRequest) -> Result<(), String>;

#[tauri::command]
fn ai_cancel(state: State<'_, AiRequests>, request_id: String);

#[tauri::command]
fn ai_set_key(provider: Provider, key: String) -> Result<(), String>;

#[tauri::command]
fn ai_has_key(provider: Provider) -> bool;

#[tauri::command]
fn ai_delete_key(provider: Provider) -> Result<(), String>;

#[tauri::command]
async fn ai_list_models(provider: Provider, base_url: Option<String>) -> Result<Vec<String>, String>;
```

`AiRequests` is managed state: `Mutex<HashMap<String, CancellationToken>>`. `ai_chat` inserts a token, streams, and removes it on completion; `ai_cancel` triggers it. (Ownership note: the token is `Clone` and cheap; the map holds one copy and the streaming task holds another, so cancelling from the map is observed by the task without sharing mutable state.)

Streamed events, emitted as `ai-stream` with a payload tagged by `request_id`:

```ts
type AiStreamEvent =
  | { requestId: string; kind: "text"; delta: string }
  | { requestId: string; kind: "tool_call"; id: string; name: string; input: unknown } // emitted once JSON is complete
  | { requestId: string; kind: "usage"; inputTokens: number; outputTokens: number; cachedTokens?: number }
  | { requestId: string; kind: "done"; stopReason: string }
  | { requestId: string; kind: "error"; message: string; status?: number };
```

Each provider adapter normalizes its own SSE format into these events, so the frontend never branches on provider.

### 4.4 Dev (browser) fallback

In `pnpm dev` there is no Rust side. `src/ai/client.ts` checks `isTauri` (`src/platform.ts`) and, in the browser, calls the provider directly with `fetch` using a key held in memory (never persisted). Anthropic requires the `anthropic-dangerous-direct-browser-access: true` header for this. The fallback is compiled in only for dev builds (`import.meta.env.DEV`).

---

## 5. Providers

### 5.1 Anthropic (Claude)

- Endpoint: Messages API with `stream: true` and tool use.
- Models offered: `claude-opus-5-5` (default), `claude-sonnet-5-5`, `claude-haiku-4-5`, `claude-fable-5-1`, plus anything the Models API returns (Settings > AI > Refresh).
- **Prompt caching**: every chat turn resends the document. Put the document in a cached block (`cache_control`) so follow-up turns are cheap and fast. Structure the prompt as `[system instructions] [document, cached] [conversation]`.

### 5.2 OpenAI and OpenAI-compatible

- Endpoint: Chat Completions (widest compatibility with third-party servers) with streaming and `tools`. Optionally the Responses API for first-party OpenAI.
- **Configurable base URL** turns this adapter into support for Ollama (`http://localhost:11434/v1`), LM Studio, OpenRouter, Azure OpenAI and others. Local models are a strong privacy story for a desktop editor.
- Tool-call support varies across local models; if a model returns no tool calls, fall back to parsing a fenced JSON block of proposals (section 6.3).

### 5.3 GitHub Copilot

This is the least certain provider and **needs verification against GitHub's current docs and terms before implementation**.

| Option | Auth | Pros | Cons |
|---|---|---|---|
| **A. GitHub Models** (`models.github.ai`, OpenAI-compatible) | GitHub PAT with `models:read`, or OAuth device flow | Officially supported, reuses the OpenAI adapter | Not the user's Copilot subscription; separate rate limits |
| **B. Copilot chat endpoint** via OAuth device flow (as some editors do) | GitHub OAuth device flow, then short-lived Copilot token exchange | Uses the user's existing Copilot subscription | Third-party use is a terms-of-service grey area; undocumented API may change |
| **C. Official Copilot SDK / extension route** (if available at implementation time) | Per GitHub docs | Supported | Availability and shape unknown today |

| **D. GitHub Copilot CLI** as a local agent (section 5.4) | The CLI's own `gh`/Copilot login | Uses the Copilot subscription through GitHub's own client; no token handling in Sarala | Requires the CLI installed; agent-style rather than chat-completion |

**Recommendation**: ship Option A first under the label "GitHub (Models)", and offer Option D through the local-agent mode for people who want to use their Copilot subscription. Only pursue B after confirming it is permitted, or C if GitHub provides it. Device flow (if used) is implemented in Rust: `ai_github_login_start() -> { user_code, verification_uri }`, then polling, with the resulting token stored in the keychain.

### 5.4 Local agent CLIs (use existing subscriptions)

Inspired by Ritemark (section 15). Many users already pay for Claude Pro/Max, ChatGPT Plus/Pro or Copilot and do not want to manage API keys. The supported way to use those subscriptions outside the vendor's own apps is the vendor's **agent CLI**, which handles login itself. Sarala can drive these headlessly:

| Agent | Headless invocation (verify flags at implementation time) | Subscription |
|---|---|---|
| Claude Code | `claude -p "<prompt>" --output-format stream-json` | Claude Pro/Max or API key |
| OpenAI Codex CLI | `codex exec --json "<prompt>"` | ChatGPT plan or API key |
| GitHub Copilot CLI | `copilot -p "<prompt>"` | Copilot subscription |
| OpenCode | `opencode run "<prompt>"` | Any configured provider |

An alternative to per-CLI adapters is the **Agent Client Protocol (ACP)**, a JSON-RPC-over-stdio protocol that several of these agents support natively or through adapters. One ACP client in Rust would cover every compliant agent; check its maturity before choosing it over per-CLI adapters.

**Rust side.** This fits the app's existing shell-out style (`pandoc`, `curl`, `run_command`). An `ai_agent_run` command spawns the CLI with `tokio::process::Command` (async, so the UI thread is not blocked), reads stdout line by line, normalizes each JSON line into the same `AiStreamEvent`s as the HTTP providers, and kills the child process on `ai_cancel`. Binary discovery reuses the PATH-resolution approach from `resolve_pandoc`. On macOS a GUI app does not inherit the login shell's `PATH`, so also probe common install locations (`~/.local/bin`, `/opt/homebrew/bin`, npm global bin) and allow an explicit path in Settings.

**The key difference: agents edit files, not buffers.** Agent CLIs write directly to disk, which conflicts with Sarala's in-memory buffer, unsaved changes and suggest-then-accept model. The plan:

1. Write the current buffer (including unsaved edits) to a **shadow workspace** in the app's temp dir: `<tmp>/sarala-agent/<session>/<file>.md`, plus read-only copies or symlinks of referenced sibling files if workspace context is enabled.
2. Run the agent with that directory as its working directory and a prompt that includes the references (as quoted text plus block markers, as in section 6.1).
3. When the agent finishes, diff the shadow file against the snapshot that was sent, and **convert the diff hunks into `AiProposal`s** (block-aligned by re-splitting with `splitBlocks`). From there the normal review flow (section 6.4) applies: stale detection, accept/reject, one undo step.
4. The user's real file is never touched by the agent. The existing file watcher and `ConflictBanner` therefore never fire for agent activity.

Restrict agent permissions where the CLI supports it (for example, allow edits only inside the shadow directory, and deny shell and network tools). The shadow directory is deleted when the session ends.

**Trade-offs versus the API providers**: slower start-up (process spawn, agent planning), coarser streaming (the agent's narration rather than token deltas), and proposals only arrive at the end of a run. In return, users get zero-key setup and can reuse subscriptions they already pay for, including Copilot.

---

## 6. Editing model: suggest, then accept

The AI **never writes into the buffer directly**. It proposes; the user disposes.

### 6.1 How the document is presented to the model

The document is sent as Markdown with stable block markers, so the model can reference exact locations:

```
<document path="notes/design.md" blocks="42">
[b0] # Design notes
[b1] Sarala is a Markdown editor ...
[b2] ## Goals
...
</document>
```

- Marker indices map to `doc.blocks[i]`; the frontend keeps a `blockIndex -> blockId` snapshot for the request so proposals survive unrelated edits (section 6.4).
- Frontmatter (`src/frontmatter.ts`) is included but flagged read-only unless the user asks.
- **Long documents**: above a configurable budget (default ~60k tokens), send the `outline` plus the blocks around the references and the caret, and give the model a `read_blocks(start, end)` tool to fetch more.

### 6.2 References (selection chips)

A reference is:

```ts
interface AiReference {
  id: string;
  blockIds: number[];          // stable ids, not indices
  startOffset?: number;        // within first block (single-block selection)
  endOffset?: number;          // within last block
  quote: string;               // the exact selected source text
}
```

- Single-block selection: offsets from `getActiveBlockApi().selectionOffsets()`.
- Cross-block selection: `selectedBlockRange()`, whole blocks.
- Rendered in the chat input as removable chips ("¶ 3 to 5: 'Sarala is a…'"); clicking a chip scrolls to and flashes the blocks.
- Sent to the model as `<reference id="r1" blocks="b3-b5">…quote…</reference>`.

### 6.3 Tools exposed to the model

```ts
propose_edit({
  block_start: number, block_end: number,   // inclusive, [bN] indices
  original: string,                         // exact current source of that range
  replacement: string,                      // new Markdown source
  rationale?: string
})

insert_blocks({ after_block: number, markdown: string, rationale?: string })

add_comment({ block: number, quote?: string, note: string, severity?: "info" | "suggestion" | "issue" })

read_blocks({ start: number, end: number })   // only offered for trimmed long documents
```

`original` is required so we can detect drift and so the model is forced to be precise.

### 6.4 Applying a proposal (`src/ai/apply.ts`)

1. Resolve `[bN]` indices to block ids using the request's snapshot, then back to **current** indices (blocks may have moved).
2. Compare the current joined source of that range with `original`. If it differs, mark the proposal **stale** and offer "Regenerate this edit".
3. Otherwise apply:
   - Single block: `updateBlock(index, replacement)` (or `replaceBlocks` when the replacement splits into several blocks; splitting is handled by `splitBlocks` in `src/markdown.ts`).
   - Range: `replaceBlocks(start, end, replacement)`, then re-split so block boundaries match what the source implies.
   - Insert: `insertBlockAfter`.
4. **Accept all** must be one undo step. Add a small batch API to the store:

   ```ts
   export function historyBatch(fn: () => void) {
     pushHistory();
     suppressHistory = true;
     try { batch(fn); } finally { suppressHistory = false; }
   }
   ```

   with `pushHistory()` returning early while `suppressHistory` is set. Apply proposals bottom-up (highest index first) so earlier indices stay valid.
5. Mark the document dirty (the store functions already do) so autosave (`src/autosave.ts`) picks it up normally.

### 6.5 Guardrails for special blocks

Blocks that are code fences, math, Mermaid, D2, tables or HTML (see `src/complexblocks.ts`, `src/blocktype.ts`) are listed in the system prompt as "preserve verbatim unless explicitly asked". Proposals touching them get a visible "modifies a code/diagram block" badge. Replacements are validated with `hasOpenFence()` so a proposal can never leave an unterminated fence that would swallow the rest of the document.

---

## 7. UI and UX

### 7.1 AI panel (`src/components/AiPanel.tsx`)

- A collapsible **right-hand panel**, resizable with the same clamp/drag logic as the sidebar (`sidebarWidth`, `clampSidebar` in `src/store.ts`). A right panel rather than a fourth left-sidebar tab, because users will want Outline and AI open together.
- Header: provider + model picker, "New chat", context indicator ("Whole document · 12.4k tokens" or "Outline + references").
- Message list: streamed Markdown answers rendered read-only with `renderMarkdown()` (no fork of the pipeline), proposal cards, comment cards.
- Input: auto-growing textarea, reference chips above it, Enter to send / Shift+Enter newline, **Enter ignored while `isComposing`**, Stop button while streaming (calls `ai_cancel`).
- Toggle: `View ▸ AI Assistant` and a shortcut (e.g. `Cmd/Ctrl+Shift+I`, checked against `src/shortcuts.ts` for conflicts).
- Focus handling follows `modalFocus.ts` conventions; accessibility follows `docs/UX-ACCESSIBILITY-AUDIT.md` (live region for streamed text, labelled controls).

### 7.2 Proposal cards

```
┌ Edit · ¶ 7 ────────────────────────────── [stale] ┐
│ − Sarala are a markdown editor that                │
│ + Sarala is a Markdown editor that                 │
│ Rationale: subject/verb agreement, product casing  │
│                      [Show in doc] [Reject] [Accept]│
└────────────────────────────────────────────────────┘
```

- Word-level diff of source text (simple LCS on tokens; no new dependency needed).
- "Show in doc" scrolls to the block and highlights it with a transient decoration class on the block wrapper (not inside the styled content, so textContent is untouched).
- When a turn yields several proposals: "Accept all" / "Reject all" at the end of the turn.

### 7.3 Selection toolbar and context menu

- `SelectionToolbar.tsx`: add an **AI** button with a dropdown: Ask about this, Improve, Shorten, Fix grammar & spelling, Change tone ▸, Explain.
- Quick actions run as one-shot requests with the selection as the only reference, and show an **inline proposal** anchored under the selection with Accept / Reject / Open in chat.
- `EditorContextMenu.tsx`: "Ask AI about selection", "Rewrite with AI…".

### 7.4 Commands

Register in `src/commands.ts` and surface in `menudata.ts`, the native menu (`src-tauri/src/menu.rs`) and the command palette:

| Command id | Action |
|---|---|
| `ai.toggle-panel` | Show/hide the AI panel |
| `ai.ask-selection` | Add selection as a reference and focus the chat input |
| `ai.review-document` | Run review mode (comments only, no edits) |
| `ai.improve-selection` / `ai.shorten-selection` / `ai.fix-grammar` | Quick actions |
| `ai.continue-writing` | Draft continuation after the caret block (also `/ai` in the slash menu) |
| `ai.new-chat` | Clear the current tab's session |
| `ai.stop` | Cancel the in-flight request |

### 7.5 Review mode

`ai.review-document` sends the document with a review-focused system prompt and only the `add_comment` tool. Comments appear as a list in the panel grouped by section (from `outline`), each clickable to jump to its block, with "Ask AI to fix" converting a comment into a targeted edit request.

### 7.6 Margin comments that mention the assistant

Also from Ritemark: instead of opening the chat, the user leaves a comment in the margin next to a passage and addresses it to the assistant (for example `@ai tighten this paragraph`). The assistant works on that passage, and the result comes back on the same comment thread as a proposal card. This keeps the request, the passage and the result together, the way a reviewer's note would.

- Comments are anchored by block id plus quote (same shape as `AiReference`), rendered in a margin gutter beside the page, outside the styled block content, so the block invariant is untouched.
- A comment without `@ai` is simply a human note. Review mode's `add_comment` results (section 7.5) appear in the same gutter.
- Storage: Phase 2 keeps comments in the AI session only. Persisting them with the document needs a format decision (sidecar `.sarala.json` versus HTML comments in the Markdown, which would change the file and appear in exports), so it is listed as an open question.

### 7.7 Settings (`SettingsModal.tsx` new "AI" section)

Built from the existing row kinds (`toggle`, `select`, `text`, `action`, `node`):

| Row | Kind | Setting key |
|---|---|---|
| Enable AI assistant | toggle | `ai.enabled` (default `false`) |
| Provider | select | `ai.provider` |
| Model | select (populated by `ai_list_models`) | `ai.model.<provider>` |
| API key | node (masked input + Save/Remove; calls `ai_set_key` / `ai_delete_key`) | keychain only |
| Base URL (OpenAI-compatible) | text | `ai.baseUrl` |
| Sign in with GitHub | action | device flow |
| Local agent (Claude Code / Codex / Copilot CLI / OpenCode) | select, shows "not found" for missing binaries | `ai.agent` |
| Agent binary path override | text | `ai.agentPath.<agent>` |
| Context sent | select: Whole document / Outline + references / References only | `ai.context` |
| Remember chats per file | toggle | `ai.persistChats` (default `false`) |
| Show token usage | toggle | `ai.showUsage` |

---

## 8. State and persistence

### 8.1 Session state (`src/ai/session.ts`)

```ts
interface AiSession {
  tabId: number;
  messages: AiChatMessage[];        // user / assistant / tool results
  proposals: AiProposal[];          // pending | accepted | rejected | stale
  comments: AiComment[];
  references: AiReference[];        // chips currently in the input
  inFlight: string | null;          // request_id
}
```

- Held in a `Map<tabId, AiSession>` signal store; created lazily. Closing a tab (`removeTab`) disposes its session and cancels any in-flight request.
- Switching tabs (`switchTab`) swaps the visible session; proposals from another tab can never be applied to the wrong document because apply is keyed by `tabId`.

### 8.2 Optional chat persistence

Off by default. When enabled, sessions are stored in the app-data dir (not next to the user's document) keyed by a hash of the file path, written with the **atomic temp-file + rename** pattern via a new `ai_save_session` command. Pending proposals are not restored across restarts (they would almost certainly be stale).

---

## 9. Prompting

System prompt outline (kept in `src/ai/prompts.ts`, versioned):

1. Role: writing assistant inside a Markdown editor.
2. Output rules: all changes via `propose_edit` / `insert_blocks`; never restate the whole document; `original` must match the source exactly; preserve Markdown syntax, frontmatter, and fenced/math/diagram blocks unless asked.
3. Enabled Markdown extensions (math delimiters, highlight `==`, sub/sup, emoji shortcodes) read from the store so suggestions use syntax the editor actually renders.
4. Style: match the document's existing tone, heading style and list markers.

Quick actions use short, action-specific prompts and constrain the model to exactly one `propose_edit` covering the reference.

---

## 10. Privacy and security

- **Opt-in**: `ai.enabled` defaults to `false`; the panel explains what is sent and to whom on first use.
- **Explicit sends only**: nothing is transmitted in the background; no telemetry.
- **Visible context**: the panel header always shows what will be sent (whole doc vs. trimmed) and the active provider/model.
- **Keys in the OS keychain**, never in `settings.json`, never returned to JS, never logged. Error messages from providers are scrubbed of headers before being emitted.
- **Treat model output as untrusted**: rendered through the existing sanitized pipeline (DOMPurify in `renderMarkdown`), and proposals are plain text until the user accepts them.
- **Prompt injection from document content**: a document may contain text like "ignore previous instructions". Since the model can only *propose* edits to the current document and has no file-system or network tools in phase 1, the impact is bounded to bad suggestions the user can reject. Phase 3 workspace tools must be read-only and confirm before reading outside the open folder.

---

## 11. Testing

| Layer | Approach |
|---|---|
| Rust adapters | Unit tests feeding recorded SSE fixtures through each adapter and asserting normalized `AiStreamEvent`s. No network in CI. |
| Apply logic | jsdom tests (`tests/ai-apply.test.mjs`): exact apply, stale detection, bottom-up Accept all is one undo step, fence-safety rejection, block id resolution after unrelated edits. |
| Session / prompt building | Unit tests for block markers, trimming for long docs, reference serialization. |
| UI | Playwright (`tests/e2e-ai.mjs`) against `pnpm dev` with a **mock provider** (`provider: "mock"` returning scripted events): send, stream, stop, accept, reject, undo, IME composition does not send. |
| Accessibility | Extend `tests/accessibility.test.mjs` for the panel and cards. |

Add the new tests to the `test` / `test:e2e` scripts in `package.json`.

---

## 12. Phased delivery

### Phase 1: MVP

- [x] Rust: `src-tauri/src/ai.rs` runs the agent CLIs (status, sign-in, run, cancel, working copies). No stored credentials.
- [x] Frontend: `src/ai/{types,agents,transport,mock,config,session,document,proposals,prompts,diff}.ts`, `AiPanel.tsx`, `AiSettings.tsx`, per-tab sessions.
- [x] References from `SelectionToolbar` and context menu.
- [x] Edits made to the working copy become proposals with accept/reject, stale detection, and `historyBatch` for Accept all.
- [x] Settings "AI" section; feature off by default.
- [x] Mock agent for development; `tests/ai.test.mjs` and `tests/e2e-ai.mjs`.
- [x] Claude Code and Codex command lines verified end to end (edit + resume) outside the app.
- [ ] Full run in the desktop app (`pnpm tauri dev`), sign-in from the app, a successful Copilot run, Windows/Linux/snap.

### Phase 2: Editing ergonomics

- [x] Quick actions (Improve, Shorten, Fix, Explain) from the selection toolbar, context menu and palette. They run in the panel.
- [ ] Inline proposals anchored under the selection.
- [x] Review mode (a text reply; the agent is told not to edit).
- [ ] Review comments anchored to blocks.
- [ ] `/ai` slash command, continue writing.
- [x] Local agent mode (section 5.4) became the only mode in Phase 1 (section 16).
- [ ] More agents (OpenCode, Gemini CLI), possibly through one ACP client.
- [ ] Margin comments that mention the assistant (section 7.6).
- [ ] Token usage display.
- [ ] Optional chat persistence.

### Phase 3: Workspace context

- [ ] Read-only tools over the open folder: `search_workspace` (reusing `search_in_folder`), `read_file` (reusing `read_file`), with confirmation outside the folder.
- [ ] "Make this consistent with the other docs in this folder" style requests.
- [ ] Cross-file proposals opened as tabs for review (never written to disk without an explicit save).

---

## 13. File-level change list (Phase 1)

| File | Change |
|---|---|
| `src-tauri/Cargo.toml` | Add `reqwest`, `keyring`, `futures-util`, `eventsource-stream`, `tokio-util` |
| `src-tauri/src/ai/mod.rs` *(new)* | Commands, `AiRequests` state, event types |
| `src-tauri/src/ai/anthropic.rs` *(new)* | Messages API adapter |
| `src-tauri/src/ai/openai.rs` *(new)* | OpenAI-compatible adapter |
| `src-tauri/src/main.rs` | `mod ai;`, `.manage(AiRequests::default())`, register commands in `invoke_handler!` |
| `src-tauri/src/menu.rs` | "AI Assistant" menu items |
| `snap/snapcraft.yaml` | `password-manager-service` plug (if keychain is used on Linux) |
| `src/ai/client.ts` *(new)* | `invoke`/`listen` wrapper + dev fetch fallback |
| `src/ai/session.ts` *(new)* | Per-tab sessions, request building, event handling |
| `src/ai/apply.ts` *(new)* | Proposal validation and application |
| `src/ai/prompts.ts` *(new)* | System and quick-action prompts |
| `src/ai/diff.ts` *(new)* | Word-level diff for proposal cards |
| `src/components/AiPanel.tsx` *(new)* | Panel UI |
| `src/components/AiProposalCard.tsx` *(new)* | Diff card |
| `src/store.ts` | `historyBatch()`, `aiPanelOpen` / width signals, dispose sessions in `removeTab` |
| `src/commands.ts`, `src/menudata.ts` | `ai.*` commands |
| `src/components/SelectionToolbar.tsx` | AI button and dropdown |
| `src/components/EditorContextMenu.tsx` | AI entries |
| `src/components/SettingsModal.tsx`, `src/settings.ts` | AI section and hydration |
| `src/App.tsx` | Mount `AiPanel` beside `<main class="main">` |
| `src/styles/app.css` | Panel, chips, cards (theme variables only, so all themes including `custom` work) |
| `tests/ai-apply.test.mjs`, `tests/e2e-ai.mjs` *(new)* | Tests |

---

## 14. Open questions

1. **Copilot**: which route (section 5.3) is acceptable under GitHub's terms at implementation time?
2. **Linux keychain in the snap**: does `password-manager-service` work reliably across distros, or do we need an encrypted-file fallback?
3. **Default context**: whole document (better answers, more tokens) or outline + references (cheaper, more private)?
4. **Panel placement on narrow windows**: overlay the editor below a width threshold, or push the content?
5. **Chat persistence**: is per-file history worth the extra storage and privacy surface, or should chats be session-only?
6. **Agent integration**: per-CLI adapters or one ACP client? Which agents support ACP natively today?
7. **Comment storage**: if margin comments should persist with the document, sidecar file or inline HTML comments?

---

## 15. Prior art: Ritemark

[Ritemark](https://ritemark.app/en/) is an open-source (MIT), local-first Markdown editor with a built-in AI agent. Takeaways from its public site:

| Ritemark does | What we take from it |
|---|---|
| Three-pane layout: folder on the left, document in the middle, agent panel on the right | Confirms the right-hand panel choice (section 7.1). |
| Built-in agents are Claude Code, Codex and OpenCode, and the agent and model can be switched within one conversation | Adds local agent mode (section 5.4). Keep the provider/model picker in the panel header and allow switching mid-session (messages are provider-neutral, so this is free). |
| Uses "the ChatGPT or Claude plan you already pay for" or your own keys (OpenAI, Google, Anthropic, OpenRouter) | Offer both routes: agent CLIs for subscriptions, API keys for direct access. OpenRouter and Google are covered by the OpenAI-compatible adapter. |
| "Comment in the margin, mention the agent, and it works on that passage" | Adds margin comments (section 7.6). |
| The agent works on the real files in the folder and reports an edit summary for review | We deliberately differ: Sarala keeps the user's file untouched and turns agent output into reviewable proposals via a shadow workspace, preserving unsaved buffers, undo and the suggest-then-accept model. |
| No account, no cloud, and "what the agent reads goes to that provider" | Matches our privacy stance (section 10); copy that plain-language disclosure into the first-run panel. |

Ritemark's public pages do not describe its edit-review mechanics (diffs, undo) in detail, so the proposal and undo design in section 6 is our own.

---

## 16. Current design: agent CLIs, no stored credentials (Phase 1)

Decision (2026-09-30): the assistant works only through agent CLIs installed on the user's machine. Sarala stores no keys or tokens. The API-key providers (Anthropic and OpenAI over HTTP, OS keychain storage) from the first Phase 1 build were removed, along with their dependencies.

**Why not OAuth inside Sarala?** GitHub allows third-party OAuth (and GitHub Models), but Claude.ai and ChatGPT subscription sign-in is reserved for the vendors' own clients, which include these CLIs. Running the CLI's own login gives the same experience (the provider's OAuth page opens in the browser) while the token stays in the CLI's store.

### How a turn works

1. The frontend snapshots the blocks and sends the joined Markdown, the prompt, the agent, and the CLI's session id (if any) to `ai_agent_run`.
2. Rust writes it (temp + rename) to `<app cache>/ai-workspaces/<chat id>/document.md` and starts the CLI there with stdin closed.
3. Each stdout line (JSONL) is forwarded as an `ai-agent` event; `src/ai/agents.ts` extracts reply text, an activity label, the session id, and errors.
4. On exit Rust sends back the working copy. `diffBlocks` (block-level LCS against the snapshot) turns every changed region into an edit or insert proposal. Proposals keep block ids and are checked against the live document at accept time, as before.
5. The next turn overwrites the working copy with the user's current document and resumes the CLI session; the prompt says the file may have changed and lists which changes were accepted or rejected.

The agent never touches the user's real file. Working copies are deleted on New chat, tab close, and app start.

### Per-CLI invocation (verified with Claude Code 2.1.284, Codex 0.158.0; Copilot 1.0.43 partly)

| Agent | Turn | Resume | Restrictions |
|---|---|---|---|
| Claude Code | `claude -p <prompt> --output-format stream-json --verbose --include-partial-messages` | `--resume <session_id>` (from the `system/init` event) | `--restricted --strict-mcp-config --tools Read,Edit,Write --permission-mode acceptEdits`: no shell, file tools confined to the working copy folder, user/project settings and MCP servers ignored |
| OpenAI Codex | `codex exec --json --skip-git-repo-check -c sandbox_mode="workspace-write" <prompt>` | `codex exec resume <thread_id> …` (from `thread.started`) | Sandbox: writes only inside the working folder. It may still run read-only shell commands (`cat`, `rg`) |
| GitHub Copilot CLI | `copilot -p <prompt> --output-format json` | `--resume=<sessionId>` (from the `result` event) | `--allow-tool=write --deny-tool=shell --no-ask-user --disable-builtin-mcps --no-custom-instructions --no-auto-update` |

Copilot's error and result events were captured, but a successful run could not be recorded (the test account was over its monthly quota), so its message events are parsed leniently and need a real check.

### Rust commands (`src-tauri/src/ai.rs`)

| Command | Purpose |
|---|---|
| `ai_agent_status(agent, path?)` | Find the CLI (PATH plus common install folders, since a macOS GUI app doesn't inherit the shell PATH), report version and sign-in (`claude auth status`, `codex login status`; Copilot has no status command) |
| `ai_agent_login(request_id, agent, path?)` | Run `claude auth login` / `codex login` / `copilot login`, streaming output so device codes and URLs are shown |
| `ai_agent_run(...)` | One turn, as above |
| `ai_agent_cancel(request_id)` | Kill the run or login |
| `ai_agent_forget(workspace_id)` | Delete a working copy |

No new crates: processes use `std::process` with reader threads. The child's PATH includes the CLI's own folder so npm-installed CLIs find `node`, and `USER` is filled in when a launcher omits it (Claude Code needs it to find its keychain entry). Windows children get `CREATE_NO_WINDOW`.

### UI

Settings > AI: on/off, Agent (Claude Code / OpenAI Codex / GitHub Copilot CLI), Status (version, account, **Sign in…**, Refresh, install command when missing), Model (optional, passed as `--model`), Program path (optional override). Other entry points are unchanged: panel, selection toolbar "Ask AI", context menu, View menu, command palette, `Shift+Cmd/Ctrl+I`. Review replies are plain chat text now; there are no comment cards.

### Tests

`tests/ai.test.mjs` runs the parsers against real captured Claude Code and Codex output (`tests/fixtures/ai/`), plus `diffBlocks`, resolution, batching, and prompts. `tests/e2e-ai.mjs` drives the panel with a dev-only mock agent that prints Claude Code's format and edits the working copy. `cargo test live_status -- --ignored --nocapture` checks discovery and sign-in against the installed CLIs.

### Chats: several per document, saved across restarts

- A document can have several chats (tabs in the panel). Each has its own transcript, proposals, CLI session and working copy, so chats can run at the same time. A chat keeps the agent it started with.
- Chats of saved documents are written (temp + rename) to `<app data>/ai-chats/<fnv1a(path)>.json`, including each chat's CLI session id, so the next message after a restart resumes the agent's conversation (`--resume` / `exec resume`). Untitled documents keep chats in memory until their first save; rename and Save As move them.
- Working copies are named after the chat and kept (pruned after 30 days unused), because Claude Code ties a resumable session to the folder it ran in. If a CLI no longer has the session, the message is retried once in a fresh session with a notice.
- Editor block ids don't survive a restart, so pending proposals are re-found by their text (nearest to their old position) or marked out of date. A run cut off by quitting shows as interrupted.

### When no agent can run

- `src/ai/availability.ts` checks all three CLIs when the panel opens, when the assistant is turned on, and when the window regains focus (throttled).
- Onboarding lists each agent (ready / signed out / not installed, install command with Copy, install guide link, Sign in). "Turn on" is disabled until one is installed, and picks the best available agent.
- With the assistant on and nothing installed, an "Install an agent to get started" screen replaces the chat, and the rail shows an amber setup dot.
- If the chat's agent is missing or signed out, the composer and suggestions are disabled with the reason (and a switch button when another agent works); `send` refuses too, so no failed chats are created. If the default agent disappears, new chats move to one that works, with a note.

### Not yet verified

A full run inside the desktop app (`pnpm tauri dev`); the sign-in flows started from the app (the CLIs were already signed in); Copilot success output; Windows and Linux discovery, including the snap sandbox (the snap will likely need access to the user's home folder to run CLIs installed there).
