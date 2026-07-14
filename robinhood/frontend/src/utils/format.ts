/**
 * Money / quantity formatting helpers.
 *
 * PostgreSQL returns DECIMAL/NUMERIC columns as strings through `pg` (to avoid
 * float precision loss), so any value coming from a raw `SELECT *` may be a
 * string even when the TypeScript type claims `number`. Calling .toFixed()
 * directly on those values throws "toFixed is not a function" at runtime.
 *
 * Orders (avg_fill_price, limit_price, stop_price, quantity) and price alerts
 * (target_price) are returned straight from the DB, so they must go through
 * these helpers. Portfolio values are already parseFloat'ed server-side.
 */

type Numeric = number | string | null | undefined;

/** Coerces an API numeric value to a number, defaulting to 0. */
export function toNumber(value: Numeric): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Formats an API numeric value with a fixed number of decimals (default 2). */
export function formatPrice(value: Numeric, digits = 2): string {
  return toNumber(value).toFixed(digits);
}

/** True when the value is null/undefined or not parseable — i.e. nothing to show. */
export function isBlank(value: Numeric): boolean {
  if (value === null || value === undefined || value === '') return true;
  return !Number.isFinite(typeof value === 'number' ? value : parseFloat(String(value)));
}

/**
 * Formats a share quantity: whole numbers render without decimals, fractional
 * shares render with 4 decimals.
 */
export function formatQuantity(value: Numeric): string {
  const n = toNumber(value);
  return n % 1 === 0 ? n.toFixed(0) : n.toFixed(4);
}
