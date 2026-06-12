import { stats, sourceMode, setSourceMode, theme, THEMES } from "../store";
import { executeCommand } from "../commands";

export default function StatusBar() {
  const cycleTheme = () => {
    const next = THEMES[(THEMES.indexOf(theme()) + 1) % THEMES.length];
    // Through the command bus so persistence and menu radio sync apply.
    executeCommand(`themes.set.${next}`);
  };
  const label = () => theme().charAt(0).toUpperCase() + theme().slice(1);

  return (
    <footer class="statusbar">
      <span>{stats().words} words</span>
      <span class="sep">·</span>
      <span>{stats().chars} characters</span>
      <span class="spacer" />
      <button class="ghost-btn" onClick={() => setSourceMode(!sourceMode())}>
        {sourceMode() ? "Live view" : "Source mode"}
      </button>
      <button class="ghost-btn" title="Cycle theme" onClick={cycleTheme}>
        {label()}
      </button>
    </footer>
  );
}
