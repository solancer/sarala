/** Legacy diagram grammar translated to Mermaid with stable internal IDs.
 * Labels never become executable Mermaid statements; external links travel
 * separately and are restored as safe SVG anchors after rendering.
 */
export interface LegacyLink { id: string; url: string }
export interface LegacyDiagram { source: string; links: LegacyLink[] }
const escapeLabel = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\\n/g, "<br/>");
const messageText = (text: string) => text.replace(/#/g, "#35;").replace(/;/g, "#59;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\\n/g, "<br/>");
const safeLink = (value: string) => {
  try { const url = new URL(value); return ["https:", "http:", "mailto:"].includes(url.protocol) && !url.username && !url.password ? url.href : null; } catch { return null; }
};
const unquote = (text: string) => text.trim().replace(/^"([\s\S]*)"$/, "$1");

export function parseLegacyDiagram(source: string, kind: "sequence" | "flow"): LegacyDiagram {
  const lines = source.split("\n").map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  const links: LegacyLink[] = [];
  if (kind === "sequence") {
    const participants = new Map<string, { id: string; label: string }>();
    const participant = (raw: string) => {
      const name = unquote(raw);
      if (!name) throw new Error("Sequence participant cannot be empty.");
      if (!participants.has(name)) participants.set(name, { id: `p${participants.size}`, label: name });
      return participants.get(name)!;
    };
    const events: string[] = [];
    let title = "";
    for (const line of lines) {
      const heading = /^title\s*:\s*(.*)$/i.exec(line);
      if (heading) { title = `title ${messageText(heading[1])}`; continue; }
      const declared = /^participant\s+("[^"]+"|.+?)(?:\s+as\s+(.+))?$/i.exec(line);
      if (declared) { const p = participant(declared[1]); if (declared[2]) p.label = unquote(declared[2]); continue; }
      const note = /^note\s+(left of|right of|over)\s+([^:]+):\s*(.*)$/i.exec(line);
      if (note) {
        const names = note[2].split(",").map(name => participant(name).id);
        if (names.length > 2 || names.length > 1 && note[1].toLowerCase() !== "over") throw new Error(`Invalid note participants: ${line}`);
        events.push(`Note ${note[1].toLowerCase()} ${names.join(",")}: ${messageText(note[3])}`); continue;
      }
      const message = /^(.*?)(--?>>?)(.*?):\s*(.*)$/.exec(line);
      if (!message) throw new Error(`Unsupported sequence statement: ${line}`);
      const from = participant(message[1]), to = participant(message[3]);
      // Legacy >> denotes an open arrow; Mermaid uses a single > for that.
      const arrow = (message[2].startsWith("--") ? "--" : "-") + (message[2].endsWith(">>") ? ">" : ">>");
      events.push(`${from.id}${arrow}${to.id}: ${messageText(message[4])}`);
    }
    return { source: ["sequenceDiagram", ...(title ? [title] : []), ...[...participants.values()].map(p => `participant ${p.id} as ${messageText(p.label)}`), ...events].join("\n"), links };
  }

  type Node = { id: string; type: string; label: string; state: string };
  const nodes = new Map<string, Node>();
  const connections: { from: string; to: string; branch: string; direction: string }[] = [];
  for (const line of lines) {
    const definition = /^(\w+)\s*=>\s*(start|end|operation|inputoutput|input|output|condition|subroutine|parallel)([\s\S]*)$/.exec(line);
    if (definition) {
      const [, name, type] = definition;
      if (nodes.has(name)) throw new Error(`Duplicate flow symbol: ${name}`);
      let rest = definition[3].trim(), link = "", state = "";
      const linkAt = rest.indexOf(":>");
      if (linkAt >= 0) { link = rest.slice(linkAt + 2).replace(/\[(?:blank|self|parent|top)\]$/, "").trim(); rest = rest.slice(0,linkAt); }
      const stateAt = rest.lastIndexOf("|");
      if (stateAt >= 0) { state = rest.slice(stateAt + 1).trim(); rest = rest.slice(0,stateAt); }
      if (rest && !rest.startsWith(":")) throw new Error(`Invalid flow symbol: ${line}`);
      const node = { id: `n${nodes.size}`, type, label: rest.startsWith(":") ? rest.slice(1).trim() : type, state };
      nodes.set(name,node);
      if (link) { const url = safeLink(link); if (!url) throw new Error(`Unsupported diagram link: ${link}`); links.push({id:node.id,url}); }
      continue;
    }
    const chain = line.split("->").map(part => /^(\w+)(?:\(([^)]+)\))?$/.exec(part.trim()));
    if (chain.length < 2 || chain.some(part => !part)) throw new Error(`Unsupported flow statement: ${line}`);
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i]!, b = chain[i + 1]!;
      const options = (a[2] ?? "").split(",").map(s => s.trim()).filter(Boolean);
      const direction = options.find(s => ["left", "right", "top", "bottom"].includes(s)) ?? "";
      const branch = options.filter(s => !["left", "right", "top", "bottom"].includes(s)).join(",");
      connections.push({from:a[1],to:b[1],branch,direction});
    }
  }
  const primary = connections.find(edge => edge.direction)?.direction;
  const orientation = primary === "right" ? "LR" : primary === "left" ? "RL" : primary === "top" ? "BT" : "TD";
  const statements = [`flowchart ${orientation}`];
  const states = new Map<string,string>();
  for (const node of nodes.values()) {
    const label = `"${escapeLabel(node.label)}"`;
    const shape = node.type === "condition" ? `{${label}}` : node.type === "start" || node.type === "end" ? `([${label}])` : node.type === "subroutine" ? `[[${label}]]` : ["inputoutput","input","output"].includes(node.type) ? `[/${label}/]` : node.type === "parallel" ? `{{${label}}}` : `[${label}]`;
    statements.push(`${node.id}${shape}`);
    if (node.state) {
      if (!states.has(node.state)) states.set(node.state, `state${states.size}`);
      statements.push(`class ${node.id} ${states.get(node.state)}`);
    }
  }
  for (const edge of connections) {
    const from = nodes.get(edge.from), to = nodes.get(edge.to);
    if (!from || !to) throw new Error(`Undefined flow symbol: ${!from ? edge.from : edge.to}`);
    statements.push(`${from.id} -->${edge.branch ? `|"${escapeLabel(edge.branch)}"|` : ""} ${to.id}`);
  }
  const fills: Record<string,string> = { past:"#cccccc",current:"#ffff00",future:"#ffff99",request:"#60a5fa",invalid:"#444444",approved:"#58c4a3",rejected:"#c45879" };
  for (const [name,id] of states) statements.push(`classDef ${id} fill:${Object.hasOwn(fills,name) ? fills[name] : "#e5e7eb"},color:${name === "invalid" ? "#ffffff" : "#111111"}`);
  return {source:statements.join("\n"),links};
}

export function legacyDiagram(source: string, kind: "sequence" | "flow"): string {
  return parseLegacyDiagram(source,kind).source;
}

/** Restore safe links after Mermaid's strict sanitizer intentionally removes click directives. */
export function applyLegacyLinks(container: Element, links: LegacyLink[]) {
  for (const link of links) {
    if (!link || typeof link.id !== "string" || typeof link.url !== "string") continue;
    const url = safeLink(link.url);
    if (!url || !/^n\d+$/.test(link.id)) continue;
    const node = container.querySelector<SVGGElement>(`g[id^="flowchart-${link.id}-"]`);
    if (!node || node.closest("a")) continue;
    const anchor = document.createElementNS("http://www.w3.org/2000/svg", "a");
    anchor.setAttribute("href", url); anchor.setAttribute("target", "_blank");
    anchor.setAttribute("rel", "noopener noreferrer"); anchor.setAttribute("data-diagram-link", "");
    anchor.setAttribute("aria-label", `${node.textContent?.trim() || "Diagram link"}: ${url}`);
    node.replaceWith(anchor); anchor.append(node);
  }
}
