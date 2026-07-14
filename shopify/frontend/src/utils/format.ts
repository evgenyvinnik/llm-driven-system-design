/**
 * Money formatting helpers.
 *
 * PostgreSQL returns DECIMAL/NUMERIC columns as strings through `pg` (to avoid
 * float precision loss). The cart endpoint does `SELECT c.*`, so `carts.subtotal`
 * (DECIMAL(10,2)) arrives as a string like "59.98" even though the TypeScript
 * type says `number`.
 *
 * That breaks two ways:
 *   1. `subtotal.toFixed(2)` throws "toFixed is not a function".
 *   2. `subtotal + shipping + tax` does STRING CONCATENATION, producing a
 *      nonsense total like "59.9805.998".
 *
 * Always run cart/order money through `toNumber` before doing arithmetic on it.
 * (Variant prices come back via json_agg/json_build_object, which emits real
 * JSON numbers, so those are already safe.)
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
