/**
 * Keyboard support for the app's context menus (editor, image), following the
 * WAI-ARIA menu pattern: the first item takes focus on open; Up/Down/Home/End
 * move; Right opens a submenu and Left closes it; Enter/Space activate;
 * Escape and Tab close and hand focus (and the text selection the menu acts
 * on) back to where it was.
 *
 * The menu items act on mousedown (so the editor's selection survives a
 * click); keyboard activation re-dispatches that event, so both paths run the
 * same handler.
 */

const ITEM = '[role="menuitem"]:not([disabled]):not([aria-disabled="true"])';

/** Where a keyboard-opened menu should appear: at the caret or focused element. */
export function keyboardMenuPoint(): { x: number; y: number } {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return { x: r.left, y: r.bottom + 4 };
  }
  const el = document.activeElement as HTMLElement | null;
  const r = el?.getBoundingClientRect();
  return r ? { x: r.left + 12, y: r.top + 12 } : { x: 40, y: 80 };
}

/**
 * Wire a just-opened menu element for keyboard use. Returns a function to call
 * when it closes, which restores focus and selection.
 */
export function attachMenuKeyboard(menu: HTMLElement, close: () => void, restore?: () => void): () => void {
  const returnTo = document.activeElement as HTMLElement | null;
  const sel = window.getSelection();
  const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;

  const items = (root: Element = menu) =>
    [...root.querySelectorAll<HTMLElement>(`:scope > ${ITEM}, :scope > * > ${ITEM}`)]
      .filter((el) => el.closest('[role="menu"]') === root);
  const focusIn = (root: Element, index: number) => {
    const list = items(root);
    list[(index + list.length) % list.length]?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const current = document.activeElement as HTMLElement | null;
    const root = current?.closest('[role="menu"]') ?? menu;
    const list = items(root);
    const i = current ? list.indexOf(current) : -1;
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); focusIn(root, i + 1); break;
      case "ArrowUp": e.preventDefault(); focusIn(root, i - 1); break;
      case "Home": e.preventDefault(); focusIn(root, 0); break;
      case "End": e.preventDefault(); focusIn(root, -1); break;
      case "ArrowRight":
        if (current?.getAttribute("aria-haspopup") === "menu") {
          e.preventDefault();
          openSub(current);
        }
        break;
      case "ArrowLeft":
        if (root !== menu) {
          e.preventDefault();
          const parent = root.parentElement?.querySelector<HTMLElement>('[aria-haspopup="menu"]');
          root.parentElement?.dispatchEvent(new MouseEvent("mouseleave"));
          parent?.focus();
        }
        break;
      case "Enter":
      case " ":
        if (current && list.includes(current)) {
          if (current.getAttribute("aria-haspopup") === "menu") {
            e.preventDefault();
            openSub(current);
          } else {
            // Items that act on mousedown get it; the native click that
            // follows reaches items that act on click.
            current.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
          }
        }
        break;
      case "Tab":
        e.preventDefault();
        close();
        break;
      default:
    }
  };
  const openSub = (parent: HTMLElement) => {
    // Submenus open on hover of their wrapper.
    parent.parentElement?.dispatchEvent(new MouseEvent("mouseenter"));
    requestAnimationFrame(() => {
      const sub = parent.parentElement?.querySelector<HTMLElement>('[role="menu"]');
      if (sub) focusIn(sub, 0);
    });
  };
  menu.addEventListener("keydown", onKey);
  requestAnimationFrame(() => focusIn(menu, 0));

  return () => {
    menu.removeEventListener("keydown", onKey);
    // Only take focus back if it's still inside the (now closing) menu.
    if (document.activeElement && document.activeElement !== document.body && !menu.contains(document.activeElement)) return;
    // The element may be gone (the editor leaves editing when focus moves to
    // the menu): the caller knows how to get back there.
    if (!returnTo?.isConnected) {
      restore?.();
      return;
    }
    returnTo.focus({ preventScroll: true });
    if (range && returnTo.isContentEditable) {
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(range);
    }
  };
}
