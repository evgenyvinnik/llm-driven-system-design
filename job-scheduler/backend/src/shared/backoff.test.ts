import { describe, it, expect } from 'vitest';
import { computeBackoffMs, shouldRetry } from './backoff';

describe('shouldRetry', () => {
  it('treats max_retries as retries after the first attempt', () => {
    expect(shouldRetry(1, 0)).toBe(false);
    expect(shouldRetry(1, 1)).toBe(true);
    expect(shouldRetry(2, 1)).toBe(false);
    expect([1, 2, 3, 4].map((attempt) => shouldRetry(attempt, 3))).toEqual([true, true, true, false]);
  });
});

describe('computeBackoffMs', () => {
  it('waits between half and all of the exponential delay', () => {
    expect(computeBackoffMs(1, 1000, 60000, () => 0)).toBe(500);
    expect(computeBackoffMs(1, 1000, 60000, () => 0.999999)).toBe(1000);
    expect(computeBackoffMs(3, 1000, 60000, () => 0)).toBe(2000);
    expect(computeBackoffMs(3, 1000, 60000, () => 0.999999)).toBe(4000);
  });

  it('caps the delay at max_backoff_ms before applying jitter', () => {
    expect(computeBackoffMs(10, 1000, 5000, () => 0)).toBe(2500);
    expect(computeBackoffMs(10, 1000, 5000, () => 0.999999)).toBe(5000);
  });

  it('spreads retries of jobs that failed together', () => {
    const delays = new Set(Array.from({ length: 50 }, () => computeBackoffMs(4, 1000, 60000)));
    expect(delays.size).toBeGreaterThan(10);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(4000);
      expect(delay).toBeLessThanOrEqual(8000);
    }
  });
});
