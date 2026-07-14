/**
 * Coercion helpers for numeric values that originate from the API.
 *
 * PostgreSQL returns DECIMAL/NUMERIC columns as *strings* through `pg` (it does
 * this deliberately, to avoid silently losing precision by casting to a JS float).
 * `document_fields.x/y/width/height` are DECIMAL columns, so they arrive in the
 * browser as strings like "120.5" even though `DocumentField` declares them as
 * `number`.
 *
 * This matters for inline styles: React only appends "px" to *numeric* style
 * values. Passing the string "120.5" produces `left: 120.5`, which is invalid
 * CSS (no unit), so the browser drops the declaration and every absolutely
 * positioned field overlay collapses onto the container's top-left corner.
 */

/** A numeric value coming from the API, which may be a string or a number. */
export type ApiNumber = number | string | null | undefined;

/** Coerces an API numeric value to a real number, defaulting to 0. */
export function toNumber(value: ApiNumber): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value ?? 0));
  return Number.isFinite(n) ? n : 0;
}

/** Converts an API numeric value into a CSS pixel length React can render. */
export function toPx(value: ApiNumber): number {
  return toNumber(value);
}
