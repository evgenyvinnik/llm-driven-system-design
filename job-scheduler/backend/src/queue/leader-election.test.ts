import { describe, it, expect, vi, beforeEach } from 'vitest';

/** Minimal Redis fake: one key with PX expiry measured on the test clock. */
const { time, keys, fakeRedis } = vi.hoisted(() => {
  const time = { now: 0 };
  const keys = new Map<string, { value: string; expiresAt: number }>();
  const live = (key: string) => {
    const entry = keys.get(key);
    if (entry && entry.expiresAt <= time.now) keys.delete(key);
    return keys.get(key);
  };
  const fakeRedis = {
    failing: false,
    async set(key: string, value: string, _px: 'PX', ttl: number, _nx: 'NX') {
      if (fakeRedis.failing) throw new Error('connection refused');
      if (live(key)) return null;
      keys.set(key, { value, expiresAt: time.now + ttl });
      return 'OK';
    },
    async get(key: string) {
      return live(key)?.value ?? null;
    },
    // Evaluates the two Lua scripts by what they do: compare the value, then act.
    async eval(script: string, _n: number, key: string, owner: string, ttl?: number) {
      if (fakeRedis.failing) throw new Error('connection refused');
      const entry = live(key);
      if (!entry || entry.value !== owner) return 0;
      if (script.includes('pexpire')) entry.expiresAt = time.now + Number(ttl);
      else keys.delete(key);
      return 1;
    },
  };
  return { time, keys, fakeRedis };
});

vi.mock('./redis', () => ({ redis: fakeRedis }));

import { LeaderElection } from './leader-election';

const TTL = 30_000;
const make = (id: string) =>
  new LeaderElection(id, 'leader', TTL, { now: () => time.now, safetyMarginMs: 2_000 });

beforeEach(() => {
  time.now = 0;
  keys.clear();
  fakeRedis.failing = false;
});

describe('LeaderElection', () => {
  it('lets exactly one instance hold the lease', async () => {
    const a = make('a');
    const b = make('b');
    expect(await a.tryAcquire()).toBe(true);
    expect(await b.tryAcquire()).toBe(false);
    expect(a.isLeader()).toBe(true);
    expect(b.isLeader()).toBe(false);
    await a.release();
  });

  it('steps down on its own when the local deadline passes without a renewal', async () => {
    const a = make('a');
    await a.tryAcquire();
    time.now = TTL - 2_001;
    expect(a.isLeader()).toBe(true);
    time.now = TTL - 2_000; // the safety margin: stop before Redis can expire the key
    expect(a.isLeader()).toBe(false);
  });

  it('extends the deadline on a successful renewal', async () => {
    const a = make('a');
    await a.tryAcquire();
    time.now = 10_000;
    expect(await a.renew()).toBe(true);
    time.now = 35_000;
    expect(a.isLeader()).toBe(true);
    await a.release();
  });

  it('steps down immediately when another instance owns the key', async () => {
    const a = make('a');
    const b = make('b');
    await a.tryAcquire();
    time.now = TTL + 1; // a stalled past its TTL; the key expired
    expect(await b.tryAcquire()).toBe(true);
    expect(await a.renew()).toBe(false);
    expect(a.isLeader()).toBe(false);
    expect(await b.getCurrentLeader()).toBe('b');
    await b.release();
  });

  it('keeps leading through a Redis error only until its deadline', async () => {
    const a = make('a');
    await a.tryAcquire();
    fakeRedis.failing = true;
    time.now = 10_000;
    expect(await a.renew()).toBe(true);
    time.now = 29_000;
    expect(await a.renew()).toBe(false);
    expect(a.isLeader()).toBe(false);
  });

  it('never releases a lease it does not hold', async () => {
    const a = make('a');
    const b = make('b');
    await a.tryAcquire();
    time.now = TTL + 1;
    await b.tryAcquire();
    await a.release();
    expect(await b.getCurrentLeader()).toBe('b');
    await b.release();
  });
});
