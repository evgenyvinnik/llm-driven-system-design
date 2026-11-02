import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import {
  MAX_TRANSFER_CENTS,
  isUuid,
  parseAmountCents,
  parseIdempotencyKey,
  parseIntParam,
  parseNote,
} from './validation.js';
import { PaymentError } from './errors.js';

function expectPaymentError(fn: () => unknown, status: number, code: string) {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PaymentError);
    expect((err as PaymentError).status).toBe(status);
    expect((err as PaymentError).code).toBe(code);
    return;
  }
  throw new Error('expected a PaymentError');
}

describe('parseAmountCents', () => {
  it('accepts positive integer cents up to the limit', () => {
    expect(parseAmountCents(1, MAX_TRANSFER_CENTS)).toBe(1);
    expect(parseAmountCents(MAX_TRANSFER_CENTS, MAX_TRANSFER_CENTS)).toBe(MAX_TRANSFER_CENTS);
  });

  it('refuses numeric strings, which JavaScript would concatenate onto a balance', () => {
    // 5000 + "100" === "5000100": the bug that minted money on deposit.
    expectPaymentError(() => parseAmountCents('100', MAX_TRANSFER_CENTS), 400, 'INVALID_AMOUNT');
    expectPaymentError(() => parseAmountCents([100], MAX_TRANSFER_CENTS), 400, 'INVALID_AMOUNT');
  });

  it.each([0, -1, 1.5, 0.01, NaN, Infinity, null, undefined, true, {}])('refuses %s', (value) => {
    expectPaymentError(() => parseAmountCents(value, MAX_TRANSFER_CENTS), 400, 'INVALID_AMOUNT');
  });

  it('refuses amounts over the limit and unsafe integers', () => {
    expectPaymentError(
      () => parseAmountCents(MAX_TRANSFER_CENTS + 1, MAX_TRANSFER_CENTS),
      400,
      'AMOUNT_OVER_LIMIT',
    );
    expectPaymentError(() => parseAmountCents(2 ** 53, MAX_TRANSFER_CENTS), 400, 'INVALID_AMOUNT');
  });
});

describe('parseNote', () => {
  it('trims, nulls empty notes, and caps length', () => {
    expect(parseNote(undefined)).toBeNull();
    expect(parseNote('   ')).toBeNull();
    expect(parseNote('  rent ')).toBe('rent');
    expectPaymentError(() => parseNote('x'.repeat(201)), 400, 'INVALID_NOTE');
    expectPaymentError(() => parseNote(42), 400, 'INVALID_NOTE');
  });
});

describe('isUuid', () => {
  it('accepts UUIDs and rejects anything Postgres would fail to cast', () => {
    expect(isUuid('11111111-1111-1111-1111-111111111111')).toBe(true);
    expect(isUuid('not-a-uuid')).toBe(false);
    expect(isUuid("1' OR '1'='1")).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});

describe('parseIdempotencyKey', () => {
  const req = (header?: string, body: Record<string, unknown> = {}) =>
    ({ get: () => header, body }) as unknown as Request;

  it('prefers the header, falls back to the body, and is optional', () => {
    expect(parseIdempotencyKey(req('hdr-key', { idempotencyKey: 'body-key' }))).toBe('hdr-key');
    expect(parseIdempotencyKey(req(undefined, { idempotencyKey: 'body-key' }))).toBe('body-key');
    expect(parseIdempotencyKey(req())).toBeUndefined();
  });

  it('rejects oversized or non-string keys', () => {
    expectPaymentError(() => parseIdempotencyKey(req('k'.repeat(256))), 400, 'INVALID_IDEMPOTENCY_KEY');
    expectPaymentError(
      () => parseIdempotencyKey(req(undefined, { idempotencyKey: 123 })),
      400,
      'INVALID_IDEMPOTENCY_KEY',
    );
  });
});

describe('parseIntParam', () => {
  it('clamps and falls back instead of passing NaN to SQL', () => {
    expect(parseIntParam('abc', 50, 1, 100)).toBe(50);
    expect(parseIntParam('100000', 50, 1, 100)).toBe(100);
    expect(parseIntParam('-5', 0, 0, 10)).toBe(0);
    expect(parseIntParam(undefined, 50, 1, 100)).toBe(50);
  });
});
