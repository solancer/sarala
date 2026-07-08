import { For, Show, createSignal, onCleanup, onMount } from "solid-js";
import { MENUS, BLOCK_TARGETED_IDS, blockTargetsEnabled, type MenuNode, type MenuLeaf } from "../menudata";
import { executeCommand } from "../commands";
import { recentFiles, exportPresets } from "../settings";
import { ICONS, MENU_ICONS } from "../menuicons";

// Which top-level menu is open (null = none). Module-level so it can be closed
// from anywhere, but only one menubar exists per window.
const [openIdx, setOpenIdx] = createSignal<number | null>(null);
const closeMenu = () => setOpenIdx(null);

const ACCEL_SYMBOLS: Record<string, string> = {
  Equal: "=", Minus: "-", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Comma: ",", Slash: "/", Backquote: "`", Up: "↑", Down: "↓", Enter: "↵",
};
function fmtAccel(accel: string): string {
  return accel.split("+").map((t) => ACCEL_SYMBOLS[t] ?? t).join("+");
}

function isDisabled(n: MenuLeaf): boolean {
  if (n.enabled) return !n.enabled();
  if (n.id && BLOCK_TARGETED_IDS.has(n.id)) return !blockTargetsEnabled();
  return false;
}

/** Expand a dynamic slot (recent files / export presets) at open-time. */
function expandDynamic(kind: "recent" | "export-presets"): MenuLeaf[] {
  if (kind === "recent") {
    const files = recentFiles();
    if (!files.length) return [{ label: "No Recent Files", enabled: () => false }];
    return files.map((p, i) => ({ id: `file.open_recent.item.${i}`, label: p }));
  }
  const presets = exportPresets();
  if (!presets.length) return [{ label: "No Presets", enabled: () => false }];
  return presets.map((p, i) => ({ id: `file.export.preset.${i}`, label: p.name }));
}

function runNode(n: MenuLeaf) {
  closeMenu();
  if (n.exec) document.execCommand(n.exec);
  else if (n.id) executeCommand(n.id);
}

/** The Ctrl/Cmd+K icon key for a menu node (native clipboard items are keyed by
 *  `exec:*`), or undefined when the item has no mapped icon. */
function iconKey(n: MenuLeaf): string | undefined {
  const key = n.id ?? (n.exec ? `exec:${n.exec}` : undefined);
  return key ? MENU_ICONS[key] : undefined;
}

/** Row icon; always rendered (empty when unmapped) to keep labels aligned. */
function MenuIcon(props: { k?: string }) {
  return (
    <svg
      class="menu-ic"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.8"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
      ref={(el) => (el.innerHTML = props.k ? ICONS[props.k] ?? "" : "")}
    />
  );
}

/** A single dropdown level: separators, leaves, and (recursive) submenus. */
function MenuList(props: { items: MenuNode[] }) {
  // Flatten dynamic slots into real nodes for this render pass.
  const nodes = (): (MenuNode | MenuLeaf)[] =>
    props.items.flatMap((n) => ("dynamic" in n ? expandDynamic(n.dynamic) : [n]));
  return (
    <div class="menu-dropdown">
      <For each={nodes()}>
        {(n) => {
          if ("sep" in n) return <div class="menu-sep" />;
          if ("dynamic" in n) return null;
          if (n.items) return <MenuSub node={n} />;
          const disabled = () => isDisabled(n);
          return (
            <button
              class="menu-item"
              classList={{ disabled: disabled() }}
              disabled={disabled()}
              onClick={() => runNode(n)}
            >
              <span class="menu-gutter">
                <Show when={n.checked?.()} fallback={<MenuIcon k={iconKey(n)} />}>✓</Show>
              </span>
              <span class="menu-label">{n.label}</span>
              <Show when={n.accel}>
                <span class="menu-accel">{fmtAccel(n.accel!)}</span>
              </Show>
            </button>
          );
        }}
      </For>
    </div>
  );
}

/** A submenu row that reveals its flyout on hover. */
function MenuSub(props: { node: MenuLeaf }) {
  const [open, setOpen] = createSignal(false);
  const disabled = () => isDisabled(props.node);
  return (
    <div class="menu-sub" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button class="menu-item menu-parent" classList={{ disabled: disabled() }} disabled={disabled()}>
        <span class="menu-gutter"><MenuIcon k={iconKey(props.node)} /></span>
        <span class="menu-label">{props.node.label}</span>
        <span class="menu-caret">›</span>
      </button>
      <Show when={open() && !disabled()}>
        <MenuList items={props.node.items!} />
      </Show>
    </div>
  );
}

export default function MenuBar() {
  onMount(() => {
    const onDown = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".menubar")) closeMenu();
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && closeMenu();
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onEsc);
    onCleanup(() => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onEsc);
    });
  });

  return (
    // Prevent mousedown from moving focus out of the editor: block-targeted
    // commands (Format ▸ Strong, Paragraph ▸ Heading…) act on the active
    // block's caret/selection, and letting a menu button take focus would blur
    // the block (see Block.tsx onBlur) and clear the target. The native macOS
    // menu doesn't steal page focus, which is why this only bites in-app.
    <div class="menubar" onMouseDown={(e) => e.preventDefault()}>
      <For each={MENUS}>
        {(menu, i) => (
          <div class="menubar-item">
            <button
              class="menubar-btn"
              classList={{ open: openIdx() === i() }}
              onClick={() => setOpenIdx(openIdx() === i() ? null : i())}
              onMouseEnter={() => openIdx() !== null && setOpenIdx(i())}
            >
              {menu.label}
            </button>
            <Show when={openIdx() === i()}>
              <MenuList items={menu.items} />
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
