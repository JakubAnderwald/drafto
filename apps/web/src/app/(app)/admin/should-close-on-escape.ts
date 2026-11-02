/**
 * Decides whether an Escape keypress should close the admin panel.
 *
 * Escape is shared with other parts of the app shell — the sidebar's app menu,
 * inline rename inputs and the search overlay all react to it — so the panel
 * only takes the key when nothing else plausibly owns it, and never while a
 * delete confirmation is pending.
 */
export function shouldCloseOnEscape(event: KeyboardEvent, panel: HTMLElement | null): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  if (isEditableTarget(event.target)) return false;
  if (!isTargetBodyOrInside(event.target, panel)) return false;

  // A delete confirmation is open. It has no Escape handling of its own, so
  // ignore the key rather than navigating away mid-deletion.
  if (panel?.querySelector('[role="alertdialog"]')) return false;

  // An open dropdown menu closes itself on Escape. Checked document-wide
  // because Safari leaves focus on <body> after a mouse click on the trigger.
  if (document.querySelector('[role="menu"]')) return false;

  return true;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA";
}

// Judged by the event's target — the element focused when the key was pressed —
// not by document.activeElement. React handlers run first and can unmount the
// focused element (the search overlay closing on Escape), which drops
// activeElement to <body> before this check runs.
function isTargetBodyOrInside(target: EventTarget | null, panel: HTMLElement | null): boolean {
  if (!target || target === document || target === document.body) return true;
  if (target === document.documentElement) return true;
  return target instanceof Node && (panel?.contains(target) ?? false);
}
