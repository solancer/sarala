/**
 * AI assistant preferences (persisted through settings.ts) and panel layout.
 * There are no keys or tokens here: the assistant runs the user's own agent
 * CLIs, which keep their own sign-in.
 */
import { createSignal } from "solid-js";
import { getSetting, setSetting } from "../settings";
import type { AgentId } from "./types";

/** Vite sets this; Node-bundled tests have no import.meta.env at all. */
const DEV = import.meta.env?.DEV ?? false;

export interface AgentInfo {
  id: AgentId;
  label: string;
  /** Who makes it and what sign-in it uses. */
  blurb: string;
  /** How to install it, shown when it isn't found. */
  install: string;
  /** Project page with install instructions. */
  url: string;
}

export const AGENTS: AgentInfo[] = [
  {
    id: "claude-code", label: "Claude Code", blurb: "Anthropic · Claude plan or API key",
    install: "npm install -g @anthropic-ai/claude-code", url: "https://github.com/anthropics/claude-code",
  },
  {
    id: "codex", label: "OpenAI Codex", blurb: "OpenAI · ChatGPT plan or API key",
    install: "npm install -g @openai/codex", url: "https://github.com/openai/codex",
  },
  {
    id: "copilot", label: "GitHub Copilot CLI", blurb: "GitHub · Copilot subscription",
    install: "npm install -g @github/copilot", url: "https://github.com/github/copilot-cli",
  },
  ...(DEV ? [{ id: "mock" as const, label: "Mock agent (dev only)", blurb: "Scripted, for development", install: "", url: "" }] : []),
];

export const agentInfo = (id: AgentId) => AGENTS.find((a) => a.id === id) ?? AGENTS[0];

export const [aiEnabled, setAiEnabledSig] = createSignal(false);
export const [aiAgent, setAiAgentSig] = createSignal<AgentId>("claude-code");
const [models, setModels] = createSignal<Partial<Record<AgentId, string>>>({});
const [paths, setPaths] = createSignal<Partial<Record<AgentId, string>>>({});
/** Model override for the current agent; empty means the CLI's default. */
export const aiModel = () => models()[aiAgent()] ?? "";
/** Binary path override for the current agent; empty means auto-detect. */
export const aiAgentPath = () => paths()[aiAgent()] ?? "";
export const agentPathFor = (id: AgentId) => paths()[id] ?? "";

export const [aiPanelOpen, setAiPanelOpen] = createSignal(false);
/** The slim assistant bar on the window's right edge. */
export const [aiRailVisible, setAiRailVisibleSig] = createSignal(true);
export const [aiPanelWidth, setAiPanelWidth] = createSignal(380);
export const clampAiPanel = (w: number) => Math.max(300, Math.min(680, Math.round(w)));

/** Bumped after a sign-in or path change, so status readers refetch. */
export const [statusEpoch, setStatusEpoch] = createSignal(0);
export const bumpStatus = () => setStatusEpoch((n) => n + 1);

/** Called from settings.ts once persisted settings are loaded. */
export function hydrateAiSettings() {
  setAiEnabledSig(getSetting("aiEnabled", false));
  const a = getSetting<string>("aiAgent", "claude-code");
  setAiAgentSig(AGENTS.some((x) => x.id === a) ? (a as AgentId) : "claude-code");
  setModels(getSetting<Partial<Record<AgentId, string>>>("aiModels", {}));
  setPaths(getSetting<Partial<Record<AgentId, string>>>("aiAgentPaths", {}));
  setAiPanelWidth(clampAiPanel(getSetting("aiPanelWidth", 380)));
  setAiRailVisibleSig(getSetting("aiRailVisible", true));
}

export async function setAiRailVisible(on: boolean) {
  setAiRailVisibleSig(on);
  await setSetting("aiRailVisible", on);
}

export async function setAiEnabled(on: boolean) {
  setAiEnabledSig(on);
  if (!on) setAiPanelOpen(false);
  await setSetting("aiEnabled", on);
}

export async function setAiAgent(id: AgentId) {
  setAiAgentSig(id);
  await setSetting("aiAgent", id);
}

export async function setAiModel(model: string) {
  const next = { ...models(), [aiAgent()]: model.trim() };
  setModels(next);
  await setSetting("aiModels", next);
}

export async function setAiAgentPath(path: string) {
  const next = { ...paths(), [aiAgent()]: path.trim() };
  setPaths(next);
  bumpStatus();
  await setSetting("aiAgentPaths", next);
}

export async function saveAiPanelWidth() {
  await setSetting("aiPanelWidth", aiPanelWidth());
}
