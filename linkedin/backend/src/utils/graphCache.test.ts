import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, string>();
const failing = { get: false };

vi.mock('./redis.js', () => ({
  redis: {
    get: vi.fn(async (key: string) => {
      if (failing.get) throw new Error('ECONNREFUSED');
      return store.get(key) ?? null;
    }),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
      return 'OK';
    }),
    pipeline: () => {
      const keys: string[] = [];
      const pipe = {
        incr: (key: string) => {
          keys.push(key);
          return pipe;
        },
        exec: async () => {
          for (const key of keys) store.set(key, String(Number(store.get(key) ?? '0') + 1));
          return [];
        },
      };
      return pipe;
    },
  },
}));
vi.mock('./logger.js', () => ({ logger: { warn: vi.fn() } }));
vi.mock('./metrics.js', () => ({ cacheHitsTotal: { inc: vi.fn() }, cacheMissesTotal: { inc: vi.fn() } }));

import { getCachedFirstDegree, bumpGraphVersion } from './graphCache.js';

beforeEach(() => {
  store.clear();
  failing.get = false;
});

describe('graph cache', () => {
  it('serves a hit without touching the database', async () => {
    const load = vi.fn().mockResolvedValue([2, 3]);
    await getCachedFirstDegree(1, load);
    expect(await getCachedFirstDegree(1, load)).toEqual([2, 3]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale refill that lands after the version bump', async () => {
    let finishStaleRead: (ids: number[]) => void = () => undefined;
    const staleLoad = () => new Promise<number[]>((resolve) => (finishStaleRead = resolve));

    // Reader A misses and starts loading the list from before the new connection.
    const readerA = getCachedFirstDegree(1, staleLoad);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The accept commits and bumps the version, then A finishes and caches its stale list.
    await bumpGraphVersion([1]);
    finishStaleRead([2]);
    expect(await readerA).toEqual([2]);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Reader B looks under the new version, so it never sees A's stale entry.
    const freshLoad = vi.fn().mockResolvedValue([2, 5]);
    expect(await getCachedFirstDegree(1, freshLoad)).toEqual([2, 5]);
    expect(freshLoad).toHaveBeenCalledTimes(1);
  });

  it('falls back to the database when Redis is down', async () => {
    failing.get = true;
    const load = vi.fn().mockResolvedValue([9]);
    expect(await getCachedFirstDegree(1, load)).toEqual([9]);
  });
});
