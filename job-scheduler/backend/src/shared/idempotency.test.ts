import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

/** In-memory stand-in for the few Redis commands the middleware uses. */
const { store, fakeRedis } = vi.hoisted(() => {
  const store = new Map<string, string>();
  const fakeRedis = {
    failing: false,
    async set(key: string, value: string, ...args: unknown[]) {
      if (fakeRedis.failing) throw new Error('connection refused');
      if (args.includes('NX') && store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    },
    async get(key: string) {
      if (fakeRedis.failing) throw new Error('connection refused');
      return store.get(key) ?? null;
    },
    async del(key: string) {
      return store.delete(key) ? 1 : 0;
    },
  };
  return { store, fakeRedis };
});

vi.mock('../queue/redis', () => ({ redis: fakeRedis }));

import express from 'express';
import { idempotencyMiddleware } from './idempotency';

let server: Server;
let baseUrl: string;
let executions = 0;
let nextStatus = 201;
let release: (() => void) | null = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stand-in for authenticate(): the user id comes from a header.
  app.use((req, _res, next) => {
    const userId = req.header('X-Test-User');
    if (userId) req.user = { userId, username: userId, role: 'admin', createdAt: 0, lastActivity: 0 };
    next();
  });
  app.post('/jobs', idempotencyMiddleware(), async (req, res) => {
    executions++;
    if (req.body.slow) {
      await new Promise<void>((resolve) => { release = resolve; });
    }
    res.status(nextStatus).json({ success: nextStatus < 400, run: executions });
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  store.clear();
  executions = 0;
  nextStatus = 201;
  fakeRedis.failing = false;
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/jobs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Test-User': 'alice', ...headers },
    body: JSON.stringify(body),
  });
}

describe('idempotencyMiddleware', () => {
  it('does nothing without a key, so deliberate duplicates both run', async () => {
    await post({ name: 'a' });
    await post({ name: 'a' });
    expect(executions).toBe(2);
  });

  it('replays the stored response for a retried request', async () => {
    const first = await post({ name: 'a' }, { 'Idempotency-Key': 'k1' });
    const second = await post({ name: 'a' }, { 'Idempotency-Key': 'k1' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get('idempotent-replayed')).toBe('true');
    expect(await second.json()).toEqual({ success: true, run: 1 });
    expect(executions).toBe(1);
  });

  it('rejects a reused key with a different body', async () => {
    await post({ name: 'a' }, { 'Idempotency-Key': 'k1' });
    const reused = await post({ name: 'b' }, { 'Idempotency-Key': 'k1' });
    expect(reused.status).toBe(422);
    expect(executions).toBe(1);
  });

  it('answers 409 while the first request with the key is still running', async () => {
    const first = post({ name: 'a', slow: true }, { 'Idempotency-Key': 'k1' });
    await vi.waitFor(() => expect(release).not.toBeNull());
    const concurrent = await post({ name: 'a', slow: true }, { 'Idempotency-Key': 'k1' });
    expect(concurrent.status).toBe(409);
    expect(concurrent.headers.get('retry-after')).toBe('1');
    release!();
    expect((await first).status).toBe(201);
    expect(executions).toBe(1);
  });

  it('does not store 5xx responses, so the client can retry for real', async () => {
    nextStatus = 503;
    expect((await post({ name: 'a' }, { 'Idempotency-Key': 'k1' })).status).toBe(503);
    nextStatus = 201;
    expect((await post({ name: 'a' }, { 'Idempotency-Key': 'k1' })).status).toBe(201);
    expect(executions).toBe(2);
  });

  it('scopes keys per user', async () => {
    await post({ name: 'a' }, { 'Idempotency-Key': 'shared', 'X-Test-User': 'alice' });
    const bob = await post({ name: 'a' }, { 'Idempotency-Key': 'shared', 'X-Test-User': 'bob' });
    expect(bob.headers.get('idempotent-replayed')).toBeNull();
    expect(executions).toBe(2);
  });

  it('fails closed with 503 when the idempotency store is down', async () => {
    fakeRedis.failing = true;
    const response = await post({ name: 'a' }, { 'Idempotency-Key': 'k1' });
    expect(response.status).toBe(503);
    expect(executions).toBe(0);
  });
});
