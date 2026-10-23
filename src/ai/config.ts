/**
 * AI assistant preferences (persisted through settings.ts) and panel layout.
 * There are no keys or tokens here: the assistant runs the user's own agent
 * CLIs, which keep their own sign-in.
 */
import { createSignal } from "solid-js";
import { getSetting, setSetting } from "../settings";
import { isMac } from "../platform";
import type { AgentId } from "./types";

/** Vite sets this; Node-bundled tests have no import.meta.env at all. */
const DEV = import.meta.env?.DEV ?? false;

export interface AgentInfo {
  id: AgentId;
  label: string;
  /** Who makes it and what sign-in it uses. */
  blurb: string;
  /** Ways to install it, shown when it isn't found; filtered by OS, first is recommended. */
  install: InstallMethod[];
  /** Official install guide. */
  url: string;
}

export type InstallOs = "mac" | "linux" | "windows";

export interface InstallMethod {
  /** Short tab label: "Installer", "Homebrew", "npm", "WinGet". */
  label: string;
  command: string;
  os: InstallOs[];
  /** One-line hint under the command (prerequisites, where to paste it). */
  note?: string;
}

const UNIX: InstallOs[] = ["mac", "linux"];
const ALL: InstallOs[] = ["mac", "linux", "windows"];
const TERMINAL = "Paste into Terminal, then come back.";
const POWERSHELL = "Paste into PowerShell, then come back.";
const NODE = "Needs Node.js 22 or later.";

// Commands are copied verbatim from each vendor's install docs (October 2026).
// Native installers come first: they need no Node.js and they self-update.
export const AGENTS: AgentInfo[] = [
  {
    id: "claude-code", label: "Claude Code", blurb: "Anthropic · Claude plan or API key",
    url: "https://code.claude.com/docs/en/setup",
    install: [
      { label: "Installer", command: "curl -fsSL https://claude.ai/install.sh | bash", os: UNIX, note: TERMINAL },
      { label: "Installer", command: "irm https://claude.ai/install.ps1 | iex", os: ["windows"], note: POWERSHELL },
      { label: "Homebrew", command: "brew install --cask claude-code", os: UNIX },
      { label: "WinGet", command: "winget install Anthropic.ClaudeCode", os: ["windows"] },
      { label: "npm", command: "npm install -g @anthropic-ai/claude-code", os: ALL, note: NODE },
    ],
  },
  {
    id: "codex", label: "OpenAI Codex", blurb: "OpenAI · ChatGPT plan or API key",
    url: "https://github.com/openai/codex#quickstart",
    install: [
      { label: "Installer", command: "curl -fsSL https://chatgpt.com/codex/install.sh | sh", os: UNIX, note: TERMINAL },
      { label: "Installer", command: "irm https://chatgpt.com/codex/install.ps1 | iex", os: ["windows"], note: POWERSHELL },
      { label: "Homebrew", command: "brew install --cask codex", os: UNIX },
      { label: "npm", command: "npm install -g @openai/codex", os: ALL, note: NODE },
    ],
  },
  {
    id: "copilot", label: "GitHub Copilot CLI", blurb: "GitHub · Copilot subscription",
    url: "https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli",
    install: [
      { label: "Installer", command: "curl -fsSL https://gh.io/copilot-install | bash", os: UNIX, note: TERMINAL },
      { label: "Homebrew", command: "brew install --cask copilot-cli", os: UNIX },
      { label: "WinGet", command: "winget install GitHub.Copilot", os: ["windows"], note: "Needs PowerShell 6 or later." },
      { label: "npm", command: "npm install -g @github/copilot", os: ALL, note: NODE },
    ],
  },
  ...(DEV ? [{ id: "mock" as const, label: "Mock agent (dev only)", blurb: "Scripted, for development", install: [], url: "" }] : []),
];

export const agentInfo = (id: AgentId) => AGENTS.find((a) => a.id === id) ?? AGENTS[0];

const OS: InstallOs = isMac ? "mac" : typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent) ? "windows" : "linux";

/** Install methods that apply to this OS, recommended first. */
export const installMethods = (a: AgentInfo) => a.install.filter((m) => m.os.includes(OS));

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
