import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../redis.js', () => ({ default: { eval: vi.fn() } }));
vi.mock('./logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { RateLimiter } from './rate-limiter.js';
import type { RedisClient } from '../redis.js';

describe('RateLimiter', () => {
  const evalMock = vi.fn();
  const limiter = new RateLimiter({ eval: evalMock } as unknown as RedisClient);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('checks and records the request in one script call', async () => {
    evalMock.mockResolvedValueOnce([1, 3, Date.now()]);

    const result = await limiter.checkLimit('messages:alice', 60, 60);

    expect(result).toEqual({ allowed: true, remaining: 57 });
    expect(evalMock).toHaveBeenCalledOnce();
    const [script, numKeys, key, , windowMs, limit] = evalMock.mock.calls[0];
    expect(script).toContain('ZREMRANGEBYSCORE');
    expect(script).toContain('ZADD');
    expect(numKeys).toBe(1);
    expect(key).toBe('ratelimit:messages:alice');
    expect(windowMs).toBe(60_000);
    expect(limit).toBe(60);
  });

  it('rejects over the limit with a Retry-After based on the oldest request in the window', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-10T12:00:30Z'));
    const oldest = new Date('2026-10-10T12:00:00Z').getTime();
    evalMock.mockResolvedValueOnce([0, 60, oldest]);

    const result = await limiter.checkLimit('messages:alice', 60, 60);

    // The oldest request leaves the 60 s window 30 s from now
    expect(result).toEqual({ allowed: false, remaining: 0, retryAfter: 30 });
  });

  it('fails open when Redis is unavailable', async () => {
    evalMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await limiter.checkLimit('messages:alice', 60, 60)).toEqual({ allowed: true, remaining: 60 });
  });
});
