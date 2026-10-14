import { createHash } from 'node:crypto';
import type { IncomingHttpHeaders } from 'http';

/**
 * Pure helpers for the bid endpoints' Idempotency-Key handling. The Redis side
 * (claim with SET NX, store the response, release on failure) lives in
 * redis.ts; keeping the interpretation here makes it testable without Redis.
 */

/**
 * Reads the client's key from `Idempotency-Key` (IETF draft name) or the legacy
 * `X-Idempotency-Key`. Returns null when absent and false when unusable (the
 * durable copy is stored in a VARCHAR(255) column).
 */
export function readIdempotencyKey(headers: IncomingHttpHeaders): string | null | false {
  const raw = headers['idempotency-key'] ?? headers['x-idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === undefined) return null;
  const key = value.trim();
  return key.length > 0 && key.length <= 255 ? key : false;
}

/** Hash of what the request asks for; reusing a key with a different fingerprint is a 422. */
export function requestFingerprint(...parts: Array<string | number>): string {
  return createHash('sha256').update(parts.join('\n')).digest('hex');
}

export type IdempotencyLookup =
  | { state: 'in_flight' }
  | { state: 'mismatch' }
  | { state: 'replay'; status: number; body: unknown };

/** Interprets the record behind a key that another request already claimed. */
export function interpretIdempotencyRecord(raw: string | null, fingerprint: string): IdempotencyLookup {
  // The claim expired between our SET NX and GET: treat it as busy, the client retries.
  if (!raw) return { state: 'in_flight' };
  let record: { state?: string; fingerprint?: string; status?: unknown; body?: unknown };
  try {
    record = JSON.parse(raw);
  } catch {
    return { state: 'in_flight' };
  }
  if (record.fingerprint !== fingerprint) return { state: 'mismatch' };
  if (record.state !== 'done' || typeof record.status !== 'number') return { state: 'in_flight' };
  return { state: 'replay', status: record.status, body: record.body };
}
