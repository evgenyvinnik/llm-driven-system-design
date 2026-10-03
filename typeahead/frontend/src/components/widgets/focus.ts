/**
 * Keyboard focus helper for the modal widgets (CommandPalette, MobileTypeahead).
 */

// Elements reachable with Tab; tabindex="-1" (e.g. listbox options) is excluded
const TABBABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]',
]
  .map((selector) => `${selector}:not([tabindex="-1"])`)
  .join(',');

/**
 * Keep Tab / Shift+Tab focus inside a modal container, wrapping at either end.
 * Call from the container's onKeyDown.
 */
export function trapTabKey(event: React.KeyboardEvent, container: HTMLElement | null): void {
  if (event.key !== 'Tab' || !container) return;

  const tabbable = Array.from(container.querySelectorAll<HTMLElement>(TABBABLE_SELECTOR));
  if (tabbable.length === 0) {
    event.preventDefault();
    return;
  }

  const first = tabbable[0];
  const last = tabbable[tabbable.length - 1];
  const active = document.activeElement;
  const outside = !container.contains(active);

  if (event.shiftKey && (active === first || outside)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || outside)) {
    event.preventDefault();
    first.focus();
  }
}
