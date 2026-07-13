/**
 * Money formatting helpers.
 *
 * PostgreSQL returns DECIMAL/NUMERIC columns as strings through `pg` (to avoid
 * float precision loss), so any monetary value coming from the API may be a
 * string or a number depending on whether the backend computed it in JS.
 * Calling .toFixed() directly on those values throws at runtime.
 */

type Money = number | string | null | undefined;

/** Coerces an API monetary value to a number, defaulting to 0. */
export function toNumber(value: Money): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Formats an API monetary value as a fixed 2-decimal string (no currency symbol). */
export function formatPrice(value: Money): string {
  return toNumber(value).toFixed(2);
}

/** True when a monetary value is zero, regardless of string/number representation. */
export function isFree(value: Money): boolean {
  return toNumber(value) === 0;
}
