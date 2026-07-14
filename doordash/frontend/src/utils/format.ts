/**
 * Numeric formatting helpers for values that originate from the API.
 *
 * PostgreSQL returns DECIMAL/NUMERIC columns as *strings* through `pg` (it does
 * this on purpose, to avoid silently losing precision by casting to a JS float).
 * Our DoorDash schema stores money (price, delivery_fee, min_order, subtotal,
 * tax, tip, total), ratings, and lat/lon as DECIMAL, so every one of those
 * fields arrives in the browser as a string like "2.99" even though our
 * TypeScript interfaces declare them as `number`.
 *
 * Two things break as a result:
 *   1. `value.toFixed(2)` throws "toFixed is not a function".
 *   2. `subtotal + deliveryFee` silently *concatenates* ("25.5" + "2.99").
 *
 * Always run API-sourced numbers through these helpers.
 */

/** A numeric value coming from the API, which may be a string or a number. */
export type ApiNumber = number | string | null | undefined;

/** Coerces an API numeric value to a real number, defaulting to 0. */
export function toNumber(value: ApiNumber): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Formats an API monetary value as a fixed 2-decimal string (no currency symbol). */
export function formatPrice(value: ApiNumber): string {
  return toNumber(value).toFixed(2);
}

/** Formats an API numeric value to a fixed number of decimal places. */
export function formatDecimal(value: ApiNumber, digits = 1): string {
  return toNumber(value).toFixed(digits);
}

/** True when a monetary value is zero, regardless of string/number representation. */
export function isFree(value: ApiNumber): boolean {
  return toNumber(value) === 0;
}
