import { describe, it, expect, vi } from 'vitest';

const store = new Map<string, string>();
let broken = false;
vi.mock('ioredis', () => {
  class FakeRedis {
    on = vi.fn();
    async get(k: string) {
      if (broken) throw new Error('down');
      return store.get(k) ?? null;
    }
    async set(k: string, v: string) {
      if (broken) throw new Error('down');
      store.set(k, v);
    }
    async incr(k: string) {
      if (broken) throw new Error('down');
      const n = Number(store.get(k) ?? 0) + 1;
      store.set(k, String(n));
      return n;
    }
  }
  return { default: { default: FakeRedis } };
});
vi.mock('../config/index.js', () => ({ default: { redis: { host: 'x', port: 1 } } }));

import { cacheGet, cacheSet, invalidateMailboxes, mailboxGeneration } from './redis.js';

describe('mailbox cache', () => {
  it('invalidates every view for a user with one generation bump', async () => {
    const before = await mailboxGeneration('u1');
    await cacheSet(`threads:u1:g${before}:INBOX:1:25`, { threads: [] });
    await invalidateMailboxes('u1');
    const after = await mailboxGeneration('u1');
    expect(after).not.toBe(before);
    expect(await cacheGet(`threads:u1:g${after}:INBOX:1:25`)).toBeNull();
  });

  it('fails open when Redis is down', async () => {
    broken = true;
    await expect(cacheGet('k')).resolves.toBeNull();
    await expect(cacheSet('k', 1)).resolves.toBeUndefined();
    await expect(invalidateMailboxes('u1')).resolves.toBeUndefined();
    expect(await mailboxGeneration('u1')).toMatch(/^nocache-/);
    broken = false;
  });
});
