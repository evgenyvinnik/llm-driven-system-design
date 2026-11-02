import type { Request } from 'express';
import { PaymentError } from './errors.js';

/** Per-transfer cap ($50,000), also applied to money requests since paying one is a transfer. */
export const MAX_TRANSFER_CENTS = 5_000_000;
/** Per-deposit and per-withdrawal cap ($10,000). */
export const MAX_WALLET_OP_CENTS = 1_000_000;
export const MAX_NOTE_LENGTH = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Amounts must be a JSON integer number of cents. Strings are refused, not
 * coerced: `balance + "100"` in JavaScript is string concatenation, which once
 * turned a $1 deposit into a balance of millions. Fractions would be cut off by
 * BIGINT, so they are refused too.
 */
export function parseAmountCents(value: unknown, maxCents: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new PaymentError(400, 'INVALID_AMOUNT', 'Amount must be a positive whole number of cents');
  }
  if (value > maxCents) {
    throw new PaymentError(
      400,
      'AMOUNT_OVER_LIMIT',
      `Amount exceeds the $${(maxCents / 100).toLocaleString('en-US')} limit`,
    );
  }
  return value;
}

/** Optional free-text note: trimmed, at most MAX_NOTE_LENGTH characters, null when empty. */
export function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new PaymentError(400, 'INVALID_NOTE', 'Note must be text');
  }
  const note = value.trim();
  if (note.length > MAX_NOTE_LENGTH) {
    throw new PaymentError(400, 'INVALID_NOTE', `Note must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return note || null;
}

/**
 * Idempotency key from the `Idempotency-Key` header (preferred) or the
 * `idempotencyKey` body field. Optional; when present it must be 1-255
 * printable ASCII characters.
 */
export function parseIdempotencyKey(req: Request): string | undefined {
  const raw = req.get('Idempotency-Key') ?? req.body?.idempotencyKey;
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || raw.length > 255 || !/^[\x21-\x7e]+$/.test(raw)) {
    throw new PaymentError(
      400,
      'INVALID_IDEMPOTENCY_KEY',
      'Idempotency key must be 1-255 printable characters',
    );
  }
  return raw;
}

/** Clamps a query-string integer into [min, max], falling back to a default. */
export function parseIntParam(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'string' ? Number.parseInt(value, 10) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
