import { stats } from "../store";

export default function StatusBar() {
  return (
    <footer class="statusbar">
      <span>{stats().words} words</span>
      <span class="sep">·</span>
      <span>{stats().chars} characters</span>
      <span class="spacer" />
    </footer>
  );
}
