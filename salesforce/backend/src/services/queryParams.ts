import { HttpError } from './accessPolicy.js';

export interface Pagination {
  page: number;
  limit: number;
  offset: number;
}

/**
 * Page and limit from the query string, clamped to sane bounds. Raw parseInt
 * let `limit=-1` or `page=abc` reach Postgres as a negative or NaN LIMIT/OFFSET
 * (a 500), and an unbounded `limit` let one request pull a whole table.
 */
export function parsePagination(
  query: Record<string, unknown>,
  defaultLimit: number,
  maxLimit = 200,
): Pagination {
  const rawPage = parseInt(String(query.page ?? ''), 10);
  const rawLimit = parseInt(String(query.limit ?? ''), 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, maxLimit) : defaultLimit;
  return { page, limit, offset: (page - 1) * limit };
}

/**
 * An ILIKE pattern matching `term` literally anywhere in the column. `%` and `_`
 * typed into a search box are escaped so they don't act as wildcards.
 */
export function containsPattern(term: unknown): string {
  return `%${String(term).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** A single string query value, or undefined (arrays from `?a=1&a=2` are rejected). */
export function queryString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * A money or count field from a JSON body: undefined when absent, otherwise a
 * non-negative safe integer or a 400. Money is integer cents end to end, so a
 * fractional value is a client bug rather than something to round silently.
 */
export function optionalNonNegativeInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) {
    throw new HttpError(400, `${field} must be a non-negative whole number`);
  }
  return n;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A `YYYY-MM-DD` calendar date, or undefined when absent, or a 400. */
export function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !DATE_RE.test(value) || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${field} must be a date (YYYY-MM-DD)`);
  }
  return value;
}

/** An ISO timestamp, or undefined when absent, or a 400. */
export function optionalTimestamp(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, `${field} must be a timestamp`);
  }
  return value;
}
