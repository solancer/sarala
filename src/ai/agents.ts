/**
 * Parsers for each agent CLI's JSONL output.
 *
 * Only what the panel shows is extracted: reply text, a short activity label,
 * the session id for resuming, and errors. Unknown lines are ignored, so a CLI
 * adding event types doesn't break anything. The document edits themselves
 * are not read from the stream; they come from diffing the working copy when
 * the run ends.
 */
import type { AgentEvent, AgentId, AgentParser } from "./types";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

function parseLine(line: string): Json | null {
  try {
    return obj(JSON.parse(line));
  } catch {
    return null;
  }
}

/** Human label for a tool the agent started. */
export function activityFor(tool: string): string {
  const t = tool.toLowerCase();
  if (/(edit|write|patch|str_replace|create|file_change)/.test(t)) return "Editing the document…";
  if (/(read|view|glob|grep|search|list)/.test(t)) return "Reading the document…";
  if (/(bash|shell|command|exec)/.test(t)) return "Running a command…";
  return "Working…";
}

/**
 * Claude Code: `claude -p --output-format stream-json --verbose
 * --include-partial-messages`. Text arrives as Messages API deltas wrapped in
 * `stream_event`; each model call starts with `message_start`, so a blank line
 * separates the text of successive calls.
 */
export function claudeParser(): AgentParser {
  let hasText = false;
  let newMessage = false;
  return {
    feed(line) {
      const e = parseLine(line);
      if (!e) return [];
      const out: AgentEvent[] = [];
      const sid = str(e.session_id);
      if (e.type === "system" && e.subtype === "init" && sid) out.push({ kind: "session", id: sid });
      // Subagent traffic is nested under a parent tool call; skip it.
      if (e.parent_tool_use_id) return out;
      if (e.type === "stream_event") {
        const ev = obj(e.event);
        if (!ev) return out;
        if (ev.type === "message_start") newMessage = true;
        const block = obj(ev.content_block);
        if (ev.type === "content_block_start" && block?.type === "tool_use") {
          out.push({ kind: "activity", label: activityFor(str(block.name) ?? "") });
        }
        if (ev.type === "content_block_start" && block?.type === "thinking") {
          out.push({ kind: "activity", label: "Thinking…" });
        }
        const delta = obj(ev.delta);
        const text = delta?.type === "text_delta" ? str(delta.text) : null;
        if (text) {
          out.push({ kind: "text", delta: hasText && newMessage ? `\n\n${text}` : text });
          hasText = true;
          newMessage = false;
        }
      }
      if (e.type === "result") {
        if (sid) out.push({ kind: "session", id: sid });
        if (e.is_error === true || (str(e.subtype) && e.subtype !== "success")) {
          const errors = Array.isArray(e.errors) ? e.errors.filter((x) => typeof x === "string").join("; ") : "";
          out.push({ kind: "error", message: str(e.result) || errors || `Claude Code stopped (${String(e.subtype)}).` });
        }
      }
      return out;
    },
  };
}

/**
 * OpenAI Codex: `codex exec --json`. Messages arrive whole as
 * `item.completed` items of type `agent_message`.
 */
export function codexParser(): AgentParser {
  let hasText = false;
  return {
    feed(line) {
      const e = parseLine(line);
      if (!e) return [];
      const item = obj(e.item);
      switch (e.type) {
        case "thread.started": {
          const id = str(e.thread_id);
          return id ? [{ kind: "session", id }] : [];
        }
        case "item.started":
          if (item?.type === "command_execution") return [{ kind: "activity", label: "Running a command…" }];
          if (item?.type === "file_change") return [{ kind: "activity", label: "Editing the document…" }];
          if (item?.type === "reasoning") return [{ kind: "activity", label: "Thinking…" }];
          return [];
        case "item.completed": {
          const text = item?.type === "agent_message" ? str(item.text)?.trim() : null;
          if (!text) return [];
          const delta = hasText ? `\n\n${text}` : text;
          hasText = true;
          return [{ kind: "text", delta }];
        }
        case "turn.failed": {
          const msg = str(obj(e.error)?.message) ?? "Codex could not finish the turn.";
          return [{ kind: "error", message: msg }];
        }
        case "error":
          return [{ kind: "error", message: str(e.message) ?? "Codex reported an error." }];
        default:
          return [];
      }
    },
  };
}

/**
 * GitHub Copilot CLI: `copilot -p --output-format json`. Events carry their
 * payload under `data`. Streaming deltas and whole messages are both
 * accepted; when deltas were seen, the whole message is not repeated.
 */
export function copilotParser(): AgentParser {
  let hasText = false;
  let streamed = false;
  const text = (t: string, separate: boolean): AgentEvent => {
    const delta = hasText && separate ? `\n\n${t}` : t;
    hasText = true;
    return { kind: "text", delta };
  };
  return {
    feed(line) {
      const e = parseLine(line);
      if (!e) return [];
      const type = str(e.type) ?? "";
      const data = obj(e.data) ?? {};
      if (type === "result") {
        const id = str(e.sessionId);
        return id ? [{ kind: "session", id }] : [];
      }
      if (type === "session.error") {
        return [{ kind: "error", message: str(data.message) ?? "Copilot reported an error." }];
      }
      if (type === "assistant.message_delta") {
        const d = str(data.deltaContent) ?? str(data.content);
        if (!d) return [];
        const first = !streamed;
        streamed = true;
        return [text(d, first)];
      }
      if (type === "assistant.message") {
        const whole = str(data.content);
        const wasStreamed = streamed;
        streamed = false;
        return whole && !wasStreamed ? [text(whole, true)] : [];
      }
      if (type === "tool.execution_start") {
        return [{ kind: "activity", label: activityFor(str(data.toolName) ?? str(data.name) ?? "") }];
      }
      if (type.startsWith("assistant.reasoning")) return [{ kind: "activity", label: "Thinking…" }];
      return [];
    },
  };
}

export function createParser(agent: AgentId): AgentParser {
  switch (agent) {
    case "codex":
      return codexParser();
    case "copilot":
      return copilotParser();
    default:
      // The mock speaks Claude Code's format.
      return claudeParser();
  }
}
