import { describe, it, expect, vi, beforeEach } from 'vitest';

// Replace ioredis with an offline fake before cache.ts creates its client.
vi.mock('ioredis', async () => {
  const { EventEmitter } = await import('events');
  class FakeRedis extends EventEmitter {
    status = 'ready';
    mget = vi.fn();
    eval = vi.fn();
    get = vi.fn();
    setex = vi.fn();
    del = vi.fn();
    quit = vi.fn();
    multi = vi.fn();
  }
  return { default: FakeRedis };
});

import {
  redis,
  urlCache,
  sessionCache,
  parseCachedUrl,
  serializeCachedUrl,
  isCachedUrlLive,
  urlCacheTtlSeconds,
} from './cache.js';

type FakeRedis = typeof redis & {
  status: string;
  mget: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  multi: ReturnType<typeof vi.fn>;
};
const fake = redis as unknown as FakeRedis;

/** Records MULTI commands so tests can assert on them. */
function fakeMulti(): { commands: unknown[][]; exec: ReturnType<typeof vi.fn> } {
  const commands: unknown[][] = [];
  const chain = {
    commands,
    set: (...args: unknown[]) => (commands.push(['set', ...args]), chain),
    del: (...args: unknown[]) => (commands.push(['del', ...args]), chain),
    exec: vi.fn().mockResolvedValue([]),
  };
  fake.multi.mockReturnValue(chain);
  return chain;
}

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);

describe('cached URL format', () => {
  it('round-trips an entry with an expiry', () => {
    const entry = { url: 'https://example.com/a', expiresAt: NOW + 60_000 };
    expect(parseCachedUrl(serializeCachedUrl(entry))).toEqual(entry);
  });

  it('round-trips an entry without expiry', () => {
    expect(parseCachedUrl('{"url":"https://example.com","expiresAt":null}')).toEqual({
      url: 'https://example.com',
      expiresAt: null,
    });
  });

  it('treats legacy plain-string values as a miss', () => {
    expect(parseCachedUrl('https://example.com/legacy')).toBeNull();
  });

  it('treats corrupt or wrongly typed values as a miss', () => {
    expect(parseCachedUrl(null)).toBeNull();
    expect(parseCachedUrl('{not json')).toBeNull();
    expect(parseCachedUrl('{"url":42,"expiresAt":null}')).toBeNull();
    expect(parseCachedUrl('{"url":"https://example.com","expiresAt":"tomorrow"}')).toBeNull();
  });
});

describe('expiry enforcement', () => {
  it('serves entries without expiry or with expiry in the future', () => {
    expect(isCachedUrlLive({ url: 'u', expiresAt: null }, NOW)).toBe(true);
    expect(isCachedUrlLive({ url: 'u', expiresAt: NOW + 1 }, NOW)).toBe(true);
  });

  it('refuses entries whose expiry has passed', () => {
    expect(isCachedUrlLive({ url: 'u', expiresAt: NOW }, NOW)).toBe(false);
    expect(isCachedUrlLive({ url: 'u', expiresAt: NOW - 1000 }, NOW)).toBe(false);
  });

  it('caps the TTL at 24h and at the time left before expiry', () => {
    expect(urlCacheTtlSeconds({ url: 'u', expiresAt: null }, NOW)).toBe(86400);
    expect(urlCacheTtlSeconds({ url: 'u', expiresAt: NOW + 3 * 86400 * 1000 }, NOW)).toBe(86400);
    expect(urlCacheTtlSeconds({ url: 'u', expiresAt: NOW + 2_500 }, NOW)).toBe(2);
    expect(urlCacheTtlSeconds({ url: 'u', expiresAt: NOW - 1 }, NOW)).toBe(0);
  });
});

describe('urlCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fake.status = 'ready';
    fake.emit('ready');
  });

  it('skips Redis entirely while it is not ready', async () => {
    fake.emit('close');
    expect(await urlCache.lookup('abc1234')).toEqual({ entry: null, negative: false });
    expect(fake.mget).not.toHaveBeenCalled();
  });

  it('reads positive and negative entries in one round trip', async () => {
    fake.mget.mockResolvedValue([null, '1']);
    expect(await urlCache.lookup('abc1234')).toEqual({ entry: null, negative: true });
    expect(fake.mget).toHaveBeenCalledWith('url:abc1234', 'url:neg:abc1234');
  });

  it('prefers a positive entry over a negative one', async () => {
    fake.mget.mockResolvedValue([serializeCachedUrl({ url: 'https://example.com', expiresAt: null }), '1']);
    expect(await urlCache.lookup('abc1234')).toEqual({
      entry: { url: 'https://example.com', expiresAt: null },
      negative: false,
    });
  });

  it('fails open when Redis errors', async () => {
    fake.mget.mockRejectedValue(new Error('connection reset'));
    expect(await urlCache.lookup('abc1234')).toEqual({ entry: null, negative: false });
  });

  it('never caches an already-expired link', async () => {
    await urlCache.fill('abc1234', { url: 'https://example.com', expiresAt: Date.now() - 1000 });
    expect(fake.eval).not.toHaveBeenCalled();
  });

  it('fills through the invalidation guard with a TTL bounded by expiry', async () => {
    const expiresAt = Date.now() + 120_000;
    await urlCache.fill('abc1234', { url: 'https://example.com', expiresAt });
    expect(fake.eval).toHaveBeenCalledTimes(1);
    const [, numKeys, key, guard, value, ttl] = fake.eval.mock.calls[0];
    expect([numKeys, key, guard]).toEqual([2, 'url:abc1234', 'url:inv:abc1234']);
    expect(JSON.parse(value as string)).toEqual({ url: 'https://example.com', expiresAt });
    expect(ttl).toBeGreaterThanOrEqual(119);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  it('writes negative entries with the short negative TTL', async () => {
    await urlCache.fillNegative('nope123');
    const [, , key, guard, value, ttl] = fake.eval.mock.calls[0];
    expect([key, guard, value, ttl]).toEqual(['url:neg:nope123', 'url:inv:nope123', '1', 60]);
  });

  it('invalidates both entries and sets the guard', async () => {
    const tx = fakeMulti();
    await urlCache.invalidate(['a1', 'b2']);
    expect(tx.commands).toEqual([
      ['set', 'url:inv:a1', '1', 'EX', 10],
      ['del', 'url:a1', 'url:neg:a1'],
      ['set', 'url:inv:b2', '1', 'EX', 10],
      ['del', 'url:b2', 'url:neg:b2'],
    ]);
    expect(tx.exec).toHaveBeenCalledTimes(1);
  });

  it('primes a new link and clears its negative entry', async () => {
    const tx = fakeMulti();
    await urlCache.prime('new1234', { url: 'https://example.com', expiresAt: null });
    expect(tx.commands).toEqual([
      ['set', 'url:inv:new1234', '1', 'EX', 10],
      ['del', 'url:neg:new1234'],
      ['set', 'url:new1234', '{"url":"https://example.com","expiresAt":null}', 'EX', 86400],
    ]);
  });
});

describe('sessionCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws immediately while Redis is not ready so auth can fall back to SQL', async () => {
    fake.emit('close');
    await expect(sessionCache.get('token')).rejects.toThrow('Redis not connected');
    expect(fake.get).not.toHaveBeenCalled();
  });

  it('does not cache a session with no lifetime left', async () => {
    fake.emit('ready');
    await sessionCache.set('token', 'user-1', 0);
    expect(fake.setex).not.toHaveBeenCalled();
  });
});
