import { ApiError } from './errors.js';

/**
 * Table and column names cannot be bound as `$N` parameters (the parser needs
 * them before planning), so the only correct defence is quoting. Two policies:
 *
 * - `quoteIdent` is for names that already exist in the target database. They
 *   may contain capitals, spaces or quotes if they were created through the SQL
 *   editor, so nothing is stripped: the name is wrapped in double quotes with
 *   embedded quotes doubled, which makes any string a single identifier and
 *   addresses exactly that object.
 * - `newIdentifier` is for names the DDL forms create. They must match a
 *   conservative pattern and are rejected, not silently rewritten, when they
 *   don't; then they are quoted like everything else.
 *
 * Every identifier is quoted, always, so reserved words (`order`, `user`,
 * `window`) and mixed case work without a hand-maintained keyword list.
 */

const MAX_IDENTIFIER_BYTES = 63;
const NEW_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** The dashboard browses and edits tables in this schema only (introspection lists nothing else). */
export const TARGET_SCHEMA = 'public';

/** Quotes an existing identifier. Throws a 400 for empty, over-long or NUL-containing names. */
export function quoteIdent(name: unknown, what = 'identifier'): string {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ApiError(400, `${what} is required`);
  }
  if (name.includes('\0')) {
    throw new ApiError(400, `${what} contains an invalid character`);
  }
  if (Buffer.byteLength(name, 'utf8') > MAX_IDENTIFIER_BYTES) {
    throw new ApiError(400, `${what} is longer than ${MAX_IDENTIFIER_BYTES} bytes`);
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/** Validates and quotes a name for an object the dashboard is about to create. */
export function newIdentifier(name: unknown, what = 'identifier'): string {
  if (typeof name !== 'string' || !NEW_IDENTIFIER.test(name) || name.length > MAX_IDENTIFIER_BYTES) {
    throw new ApiError(
      400,
      `Invalid ${what} "${String(name ?? '')}": use letters, digits and underscores, ` +
        `starting with a letter or underscore (max ${MAX_IDENTIFIER_BYTES} characters)`,
    );
  }
  return quoteIdent(name, what);
}

/** `"public"."<table>"` — schema-qualified so search_path can't resolve the name to a catalog table. */
export function qualifiedTable(name: unknown): string {
  return `${quoteIdent(TARGET_SCHEMA)}.${quoteIdent(name, 'table name')}`;
}
