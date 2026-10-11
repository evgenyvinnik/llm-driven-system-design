import { describe, it, expect } from 'vitest';
import { boundedTtlSeconds } from './ttl.js';

describe('boundedTtlSeconds', () => {
  const now = Date.UTC(2026, 9, 10, 12, 0, 0);

  it('uses the ceiling when the value never expires', () => {
    expect(boundedTtlSeconds(null, now, 86400)).toBe(86400);
  });

  it('uses the ceiling when expiry is further away than the ceiling', () => {
    expect(boundedTtlSeconds(now + 2 * 86400 * 1000, now, 86400)).toBe(86400);
  });

  it('shrinks to the time remaining when expiry is sooner', () => {
    expect(boundedTtlSeconds(now + 90_000, now, 86400)).toBe(90);
  });

  it('rounds down so the cache entry never outlives the value', () => {
    expect(boundedTtlSeconds(now + 2_999, now, 86400)).toBe(2);
  });

  it('returns 0 (do not cache) when less than a second is left', () => {
    expect(boundedTtlSeconds(now + 999, now, 86400)).toBe(0);
  });

  it('returns 0 for values that already expired', () => {
    expect(boundedTtlSeconds(now - 1, now, 86400)).toBe(0);
    expect(boundedTtlSeconds(now, now, 86400)).toBe(0);
  });

  it('returns 0 for a non-finite expiry', () => {
    expect(boundedTtlSeconds(Number.NaN, now, 86400)).toBe(0);
  });
});
