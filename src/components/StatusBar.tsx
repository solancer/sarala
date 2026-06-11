import { stats, sourceMode, setSourceMode, theme, setTheme } from "../store";

export default function StatusBar() {
  return (
    <footer class="statusbar">
      <span>{stats().words} words</span>
      <span class="sep">·</span>
      <span>{stats().chars} characters</span>
      <span class="spacer" />
      <button class="ghost-btn" onClick={() => setSourceMode(!sourceMode())}>
        {sourceMode() ? "Live view" : "Source mode"}
      </button>
      <button class="ghost-btn" onClick={() => setTheme(theme() === "paper" ? "graphite" : "paper")}>
        {theme() === "paper" ? "Graphite" : "Paper"}
      </button>
    </footer>
  );
}
