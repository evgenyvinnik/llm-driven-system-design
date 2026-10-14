import { describe, expect, it } from 'vitest';
import { interpretIdempotencyRecord, readIdempotencyKey, requestFingerprint } from './idempotency.js';

describe('readIdempotencyKey', () => {
  it('reads the standard header, then the legacy one', () => {
    expect(readIdempotencyKey({ 'idempotency-key': ' k1 ' })).toBe('k1');
    expect(readIdempotencyKey({ 'x-idempotency-key': 'k2' })).toBe('k2');
    expect(readIdempotencyKey({})).toBeNull();
  });

  it('rejects blank or over-long keys', () => {
    expect(readIdempotencyKey({ 'idempotency-key': '   ' })).toBe(false);
    expect(readIdempotencyKey({ 'idempotency-key': 'x'.repeat(256) })).toBe(false);
  });
});

describe('interpretIdempotencyRecord', () => {
  const fp = requestFingerprint('manual', 'auction-1', 10_500);

  it('replays a finished request with the same body', () => {
    const raw = JSON.stringify({ state: 'done', fingerprint: fp, status: 201, body: { ok: true } });
    expect(interpretIdempotencyRecord(raw, fp)).toEqual({ state: 'replay', status: 201, body: { ok: true } });
  });

  it('reports a request that is still running', () => {
    expect(interpretIdempotencyRecord(JSON.stringify({ state: 'pending', fingerprint: fp }), fp)).toEqual({ state: 'in_flight' });
    expect(interpretIdempotencyRecord(null, fp)).toEqual({ state: 'in_flight' });
  });

  it('flags the same key reused with a different body', () => {
    const other = requestFingerprint('manual', 'auction-1', 10_600);
    expect(other).not.toBe(fp);
    expect(interpretIdempotencyRecord(JSON.stringify({ state: 'done', fingerprint: other, status: 201 }), fp)).toEqual({
      state: 'mismatch',
    });
  });
});
