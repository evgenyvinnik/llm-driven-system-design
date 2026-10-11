import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Options } from 'express-rate-limit';

vi.mock('../utils/cache.js', () => ({
  redis: {
    eval: vi.fn(),
    del: vi.fn(),
  },
  isRedisConnected: vi.fn(() => true),
}));

import { redis } from '../utils/cache.js';
import { RedisFixedWindowStore, toIncrementResponse } from './rateLimit.js';

const fakeEval = vi.mocked(redis.eval as unknown as (...args: unknown[]) => Promise<unknown>);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toIncrementResponse', () => {
  it('converts the script reply into hits and reset time', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0);
    expect(toIncrementResponse([3, 1500], now)).toEqual({ totalHits: 3, resetTime: new Date(now + 1500) });
  });

  it('rejects unexpected replies', () => {
    expect(() => toIncrementResponse(null, 0)).toThrow();
    expect(() => toIncrementResponse(['x', 1], 0)).toThrow();
  });
});

describe('RedisFixedWindowStore', () => {
  it('increments a per-limiter key with the configured window', async () => {
    const store = new RedisFixedWindowStore('rl:create_url:');
    store.init({ windowMs: 3_600_000 } as Options);
    fakeEval.mockResolvedValue([1, 3_600_000]);

    const result = await store.increment('203.0.113.7');

    expect(result.totalHits).toBe(1);
    const [, numKeys, key, windowMs] = fakeEval.mock.calls[0];
    expect([numKeys, key, windowMs]).toEqual([1, 'rl:create_url:203.0.113.7', 3_600_000]);
  });

  it('gives up after its time budget so a slow Redis cannot stall requests', async () => {
    vi.useFakeTimers();
    const store = new RedisFixedWindowStore('rl:general:');
    fakeEval.mockReturnValue(new Promise(() => {})); // never answers

    const pending = store.increment('203.0.113.7');
    const assertion = expect(pending).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });

  it('decrements only existing counters', async () => {
    const store = new RedisFixedWindowStore('rl:general:');
    fakeEval.mockResolvedValue(0);
    await store.decrement('203.0.113.7');
    expect(String(fakeEval.mock.calls[0][0])).toContain("EXISTS");
  });
});
