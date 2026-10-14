import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory stand-in for the few Redis commands the service uses.
const store = vi.hoisted(() => new Map<string, string>());
vi.mock('./redis.js', () => ({
  redis: {
    set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    eval: vi.fn(async (script: string, _n: number, key: string, token: string, value?: string) => {
      const current = store.get(key);
      if (!current || JSON.parse(current).token !== token) return 0;
      if (script.includes("'DEL'")) store.delete(key);
      else store.set(key, value as string);
      return 1;
    }),
  },
}));

import { IdempotencyService, stableStringify } from './idempotency.js';

describe('IdempotencyService', () => {
  const service = new IdempotencyService();
  const fp = service.fingerprint({ channels: ['email'], data: { title: 'Hi' } });

  beforeEach(() => store.clear());

  it('fingerprints independently of key order', () => {
    expect(stableStringify({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(service.fingerprint({ data: { title: 'Hi' }, channels: ['email'] })).toBe(fp);
  });

  it('claims once, reports in-progress to a concurrent duplicate, then replays', async () => {
    const first = await service.begin('user-1', 'key-1', fp);
    expect(first.kind).toBe('new');
    expect((await service.begin('user-1', 'key-1', fp)).kind).toBe('in_progress');

    if (first.kind !== 'new') throw new Error('expected a claim');
    await service.complete('user-1', 'key-1', first.token, fp, 202, { status: 'queued' });
    expect(await service.begin('user-1', 'key-1', fp)).toEqual({ kind: 'replay', status: 202, body: { status: 'queued' } });
  });

  it('rejects a reused key with a different body', async () => {
    await service.begin('user-1', 'key-1', fp);
    expect((await service.begin('user-1', 'key-1', service.fingerprint({ other: true }))).kind).toBe('mismatch');
  });

  it('scopes keys by caller', async () => {
    await service.begin('user-1', 'shared', fp);
    expect((await service.begin('user-2', 'shared', fp)).kind).toBe('new');
  });

  it('releases a claim so the client can retry, but never someone else\'s claim', async () => {
    const first = await service.begin('user-1', 'key-1', fp);
    if (first.kind !== 'new') throw new Error('expected a claim');
    await service.release('user-1', 'key-1', 'not-my-token');
    expect((await service.begin('user-1', 'key-1', fp)).kind).toBe('in_progress');
    await service.release('user-1', 'key-1', first.token);
    expect((await service.begin('user-1', 'key-1', fp)).kind).toBe('new');
  });
});
