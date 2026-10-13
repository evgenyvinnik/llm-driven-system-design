import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const store = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  durable: new Map<string, { response_status: number; response_body: unknown; request_fingerprint: string; created_at: Date }>(),
}));

vi.mock('../config/redis.js', () => ({
  redis: {
    set: vi.fn(async (key: string, value: string, _ex: string, _ttl: number, nx?: string) => {
      if (nx === 'NX' && store.redis.has(key)) return null;
      store.redis.set(key, value);
      return 'OK';
    }),
    get: vi.fn(async (key: string) => store.redis.get(key) ?? null),
    del: vi.fn(async (key: string) => (store.redis.delete(key) ? 1 : 0)),
  },
}));
vi.mock('../config/database.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.startsWith('SELECT')) {
      const row = store.durable.get(params[0] as string);
      return { rows: row ? [row] : [] };
    }
    const [key, , , status, body, fingerprint] = params as [string, string, string, number, string, string];
    store.durable.set(key, {
      response_status: status,
      response_body: JSON.parse(body),
      request_fingerprint: fingerprint,
      created_at: new Date(),
    });
    return { rows: [] };
  }),
}));
vi.mock('../config/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { idempotencyMiddleware } from './idempotency.js';

let created = 0;
let failNext = false;
let release: (() => void) | null = null;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { session: { userId: string } }).session = { userId: 'a0000000-0000-4000-8000-000000000002' };
    next();
  });
  app.use('/api', idempotencyMiddleware);
  app.post('/api/issues', async (req, res) => {
    if (req.body.slow) await new Promise<void>((resolve) => (release = resolve));
    if (failNext) {
      failNext = false;
      return res.status(500).json({ error: 'database unavailable' });
    }
    created++;
    res.status(201).json({ issue: { key: `DEMO-${created}`, summary: req.body.summary } });
  });
  app.get('/api/issues', (_req, res) => res.json({ issues: [] }));
  return app;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  store.redis.clear();
  store.durable.clear();
  created = 0;
  failNext = false;
});

describe('idempotencyMiddleware', () => {
  it('runs the handler once and replays the stored response for a retry', async () => {
    const app = buildApp();
    const first = await request(app).post('/api/issues').set('Idempotency-Key', 'k1').send({ summary: 'Bug' });
    await settle();
    const retry = await request(app).post('/api/issues').set('Idempotency-Key', 'k1').send({ summary: 'Bug' });

    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.body).toEqual(first.body);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(created).toBe(1);
  });

  it('accepts the legacy X-Idempotency-Key header', async () => {
    const app = buildApp();
    await request(app).post('/api/issues').set('X-Idempotency-Key', 'k2').send({ summary: 'Bug' });
    await settle();
    await request(app).post('/api/issues').set('X-Idempotency-Key', 'k2').send({ summary: 'Bug' });
    expect(created).toBe(1);
  });

  it('rejects the same key with a different body', async () => {
    const app = buildApp();
    await request(app).post('/api/issues').set('Idempotency-Key', 'k3').send({ summary: 'Bug' });
    await settle();
    const reused = await request(app).post('/api/issues').set('Idempotency-Key', 'k3').send({ summary: 'Other' });
    expect(reused.status).toBe(422);
    expect(reused.body.code).toBe('idempotency_key_reused');
    expect(created).toBe(1);
  });

  it('answers 409 with Retry-After while the first request is still running', async () => {
    const app = buildApp();
    const first = request(app).post('/api/issues').set('Idempotency-Key', 'k4').send({ summary: 'Bug', slow: true });
    const firstDone = first.then((r) => r);
    await vi.waitFor(() => expect(release).not.toBeNull());

    const duplicate = await request(app).post('/api/issues').set('Idempotency-Key', 'k4').send({ summary: 'Bug', slow: true });
    expect(duplicate.status).toBe(409);
    expect(duplicate.headers['retry-after']).toBe('1');

    release!();
    release = null;
    expect((await firstDone).status).toBe(201);
    expect(created).toBe(1);
  });

  it('does not store a 5xx, so the retry runs the handler again', async () => {
    const app = buildApp();
    failNext = true;
    const failed = await request(app).post('/api/issues').set('Idempotency-Key', 'k5').send({ summary: 'Bug' });
    await settle();
    const retry = await request(app).post('/api/issues').set('Idempotency-Key', 'k5').send({ summary: 'Bug' });

    expect(failed.status).toBe(500);
    expect(retry.status).toBe(201);
    expect(created).toBe(1);
  });

  it('replays from the durable copy when Redis lost the record', async () => {
    const app = buildApp();
    await request(app).post('/api/issues').set('Idempotency-Key', 'k6').send({ summary: 'Bug' });
    await settle();
    store.redis.clear();

    const retry = await request(app).post('/api/issues').set('Idempotency-Key', 'k6').send({ summary: 'Bug' });
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(created).toBe(1);
  });

  it('ignores safe methods', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/issues').set('Idempotency-Key', 'k7');
    expect(res.status).toBe(200);
    expect(store.redis.size).toBe(0);
  });
});
