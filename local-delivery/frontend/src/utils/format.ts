/**
 * Numeric formatting helpers.
 *
 * PostgreSQL returns DECIMAL/NUMERIC columns as strings through `pg` (to avoid
 * float precision loss), so any value coming from the API that maps to a
 * DECIMAL column (price, total, rating, lat/lng, fees) may be a string or a
 * number depending on whether the backend computed it in JS.
 * Calling .toFixed() directly on those values throws
 * "TypeError: x.toFixed is not a function" at runtime.
 */

type Numeric = number | string | null | undefined;

/** Coerces an API numeric value to a number, defaulting to 0. */
export function toNumber(value: Numeric): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Formats an API monetary value as a fixed 2-decimal string (no currency symbol). */
export function formatPrice(value: Numeric): string {
  return toNumber(value).toFixed(2);
}

/** Formats an API numeric value with a fixed number of decimal places. */
export function formatNumber(value: Numeric, digits = 2): string {
  return toNumber(value).toFixed(digits);
}

/** Formats a 0..1 rate as a whole-number percentage, e.g. 0.92 -> "92%". */
export function formatPercent(value: Numeric, digits = 0): string {
  return `${(toNumber(value) * 100).toFixed(digits)}%`;
}

/** True when a monetary value is zero, regardless of string/number representation. */
export function isFree(value: Numeric): boolean {
  return toNumber(value) === 0;
}
