/**
 * Formatting helpers for values that cross the API boundary.
 *
 * The `pg` driver returns PostgreSQL DECIMAL/NUMERIC columns as **strings**, not
 * numbers, to avoid silent precision loss (JS numbers are IEEE-754 doubles and
 * cannot represent every NUMERIC value exactly). Our schema declares
 * `businesses.rating DECIMAL(2,1)` and `latitude/longitude DECIMAL(10,7)`, and
 * several endpoints serialize query rows straight to JSON. So even though the
 * TypeScript types say `rating: number`, at runtime it arrives as `"4.5"`.
 *
 * Calling `rating.toFixed(1)` on that string throws
 * `TypeError: rating.toFixed is not a function` and takes the whole page down
 * with an error boundary. These helpers coerce defensively so a string, a
 * number, null, or undefined all render sensibly.
 *
 * @module utils/format
 */

/** Coerces an API-supplied numeric value (possibly a string) to a number. Returns `fallback` for null/undefined/NaN. */
export function toNumber(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isNaN(n) ? fallback : n;
}

/** Formats a star rating for display, e.g. `4.5`. Safe against DECIMAL-as-string. */
export function formatRating(value: number | string | null | undefined): string {
  return toNumber(value).toFixed(1);
}

/** Formats a distance in kilometers, e.g. `1.2`. Safe against DECIMAL-as-string. */
export function formatDistance(value: number | string | null | undefined): string {
  return toNumber(value).toFixed(1);
}
