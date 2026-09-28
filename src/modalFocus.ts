/** Shared focus containment for mounted modal surfaces, including nested dialogs. */
const stack: HTMLElement[] = [];
const inertBefore = new Map<HTMLElement, boolean>();
const focusable = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(
  'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]',
)].filter((el) => el.tabIndex >= 0 && !el.matches(':disabled') &&
  !el.closest('[hidden], [inert], [aria-hidden="true"]') &&
  getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden');
function isolateTop() {
  for (const [el, inert] of inertBefore) el.inert = inert;
  inertBefore.clear();
  let branch = stack.at(-1);
  while (branch && branch !== document.body) {
    for (const sibling of branch.parentElement?.children ?? []) {
      if (sibling !== branch && sibling instanceof HTMLElement) {
        inertBefore.set(sibling, sibling.inert);
        sibling.inert = true;
      }
    }
    branch = branch.parentElement ?? undefined;
  }
}
export function containModalFocus(el: HTMLElement, close: () => void): () => void {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  stack.push(el);
  isolateTop();
  const focusFirst = () => (focusable(el)[0] ?? el).focus({ preventScroll: true });
  const onFocus = (e: FocusEvent) => {
    if (stack.at(-1) === el && !el.contains(e.target as Node)) focusFirst();
  };
  const onKey = (e: KeyboardEvent) => {
    if (stack.at(-1) !== el) return;
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const items = focusable(el);
    const first = items[0] ?? el;
    const last = items.at(-1) ?? el;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === el)) {
      e.preventDefault(); first.focus();
    }
  };
  el.addEventListener('keydown', onKey);
  document.addEventListener('focusin', onFocus);
  focusFirst();
  return () => {
    el.removeEventListener('keydown', onKey);
    document.removeEventListener('focusin', onFocus);
    const wasTop = stack.at(-1) === el;
    const index = stack.indexOf(el);
    if (index >= 0) stack.splice(index, 1);
    isolateTop();
    if (wasTop) {
      const target = previous?.isConnected && !previous.closest('[inert]') ? previous
        : stack.at(-1) ?? document.querySelector<HTMLElement>('.editor[tabindex], .source-full');
      target?.focus({ preventScroll: true });
    }
  };
}
