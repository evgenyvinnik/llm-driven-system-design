import crypto from 'crypto';

/**
 * Helpers for safe submission retries.
 *
 * Two kinds of duplicate reach POST /submissions, and they need different answers:
 *
 * 1. A retry of the same request: a timeout, a double click, a page refresh. The client sends
 *    the same `Idempotency-Key` header, and the server returns the original submission instead
 *    of judging the code twice. The same key with a different body is a client bug: 422.
 * 2. The same code submitted again while an identical submission is still queued or running.
 *    Judging it twice teaches nothing, so the in-flight submission is returned.
 *
 * Both rules are enforced by unique indexes in PostgreSQL (see db/init.sql) inside the
 * transaction that creates the submission. The previous version checked a Redis key and wrote it
 * after the insert, so concurrent identical requests all passed the check and were all judged.
 */

/** Visible ASCII, 1 to 255 characters: UUIDs and similar opaque client-generated tokens. */
const KEY_PATTERN = /^[\x21-\x7e]{1,255}$/;

export type ParsedIdempotencyKey =
  | { ok: true; key: string | null }
  | { ok: false; error: string };

/** Validates the optional Idempotency-Key header; a missing header is allowed. */
export function parseIdempotencyKey(header: string | string[] | undefined): ParsedIdempotencyKey {
  if (header === undefined) return { ok: true, key: null };
  if (Array.isArray(header)) return { ok: false, error: 'Send a single Idempotency-Key header' };
  const key = header.trim();
  if (!KEY_PATTERN.test(key)) {
    return { ok: false, error: 'Idempotency-Key must be 1-255 visible ASCII characters' };
  }
  return { ok: true, key };
}

/** Normalizes code so that whitespace-only differences count as the same submission. */
export function normalizeCode(code: string): string {
  return code
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Hash of the normalized code; with user, problem and language it identifies "the same code". */
export function hashCode(code: string): string {
  return sha256(normalizeCode(code));
}

/** Hash of the exact request body, used to detect an Idempotency-Key reused for another body. */
export function hashRequest(body: { problemSlug: string; language: string; code: string }): string {
  return sha256(JSON.stringify([body.problemSlug, body.language, body.code]));
}
