import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('./cache.js', () => ({
  redis: {
    set: vi.fn(),
    get: vi.fn(),
    eval: vi.fn().mockResolvedValue(1),
  },
  isRedisConnected: vi.fn(() => true),
}));

import { redis, isRedisConnected } from './cache.js';
import {
  idempotencyMiddleware,
  fingerprintRequest,
  canonicalJson,
  decideOnExistingRecord,
  isValidIdempotencyKey,
} from './idempotency.js';

const fakeRedis = redis as unknown as {
  set: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  eval: ReturnType<typeof vi.fn>;
};

const BODY = { long_url: 'https://example.com/a' };

function makeReq(body: unknown, key?: string, userId?: string): Request {
  return {
    method: 'POST',
    baseUrl: '/api/v1/urls',
    path: '/',
    body,
    user: userId ? { id: userId, role: 'user' } : undefined,
    get: (name: string) => (name.toLowerCase() === 'idempotency-key' ? key : undefined),
  } as unknown as Request;
}

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
  status(code: number): FakeResponse;
  set(name: string, value: string): FakeResponse;
  json(body: unknown): FakeResponse;
}

function makeRes(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(name, value) {
      this.headers[name] = value;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
  return res;
}

async function run(req: Request, res: FakeResponse): Promise<NextFunction> {
  const next = vi.fn() as unknown as NextFunction;
  await idempotencyMiddleware(req, res as unknown as Response, next);
  return next;
}

const fingerprintOf = (body: unknown) => fingerprintRequest('POST', '/api/v1/urls/', body);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isRedisConnected).mockReturnValue(true);
});

describe('fingerprinting', () => {
  it('ignores key order but not values', () => {
    expect(canonicalJson({ b: 2, a: { d: [1, { y: 1, x: 2 }], c: null } })).toBe(
      '{"a":{"c":null,"d":[1,{"x":2,"y":1}]},"b":2}'
    );
    expect(fingerprintOf({ long_url: 'x', custom_code: 'abcd' })).toBe(
      fingerprintOf({ custom_code: 'abcd', long_url: 'x' })
    );
    expect(fingerprintOf({ long_url: 'x' })).not.toBe(fingerprintOf({ long_url: 'y' }));
  });

  it('validates key syntax', () => {
    expect(isValidIdempotencyKey('3f1c9a52-6b7e-4d43-9a3e-2f5b8c1d0e47')).toBe(true);
    expect(isValidIdempotencyKey('has space')).toBe(false);
    expect(isValidIdempotencyKey('')).toBe(false);
    expect(isValidIdempotencyKey('k'.repeat(256))).toBe(false);
  });
});

describe('decideOnExistingRecord', () => {
  const fp = 'abc';

  it('replays a completed response for the same body', () => {
    const raw = JSON.stringify({ state: 'completed', fingerprint: fp, status: 201, body: { short_code: 'x' } });
    expect(decideOnExistingRecord(raw, fp)).toEqual({ action: 'replay', status: 201, body: { short_code: 'x' } });
  });

  it('reports in-progress requests', () => {
    const raw = JSON.stringify({ state: 'processing', fingerprint: fp, token: 't' });
    expect(decideOnExistingRecord(raw, fp)).toEqual({ action: 'in_progress' });
  });

  it('flags key reuse with a different body', () => {
    const raw = JSON.stringify({ state: 'completed', fingerprint: 'other', status: 201, body: {} });
    expect(decideOnExistingRecord(raw, fp)).toEqual({ action: 'mismatch' });
  });

  it('allows a new claim when the record vanished', () => {
    expect(decideOnExistingRecord(null, fp)).toEqual({ action: 'claim' });
  });
});

describe('idempotencyMiddleware', () => {
  it('does nothing without an Idempotency-Key header (duplicates are intentional)', async () => {
    const next = await run(makeReq(BODY), makeRes());
    expect(next).toHaveBeenCalledTimes(1);
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });

  it('rejects malformed keys with 400', async () => {
    const res = makeRes();
    const next = await run(makeReq(BODY, 'bad key'), res);
    expect(res.statusCode).toBe(400);
    expect(next).not.toHaveBeenCalled();
  });

  it('fails open when Redis is unavailable', async () => {
    vi.mocked(isRedisConnected).mockReturnValue(false);
    const next = await run(makeReq(BODY, 'key-1'), makeRes());
    expect(next).toHaveBeenCalledTimes(1);
    expect(fakeRedis.set).not.toHaveBeenCalled();
  });

  it('claims the key with SET NX EX 60, scoped by user', async () => {
    fakeRedis.set.mockResolvedValue('OK');
    const next = await run(makeReq(BODY, 'key-1', 'user-7'), makeRes());

    expect(next).toHaveBeenCalledTimes(1);
    const [redisKey, value, ex, ttl, nx] = fakeRedis.set.mock.calls[0];
    expect([redisKey, ex, ttl, nx]).toEqual(['idempotency:user-7:key-1', 'EX', 60, 'NX']);
    expect(JSON.parse(value)).toMatchObject({ state: 'processing', fingerprint: fingerprintOf(BODY) });
  });

  it('scopes anonymous requests separately', async () => {
    fakeRedis.set.mockResolvedValue('OK');
    await run(makeReq(BODY, 'key-1'), makeRes());
    expect(fakeRedis.set.mock.calls[0][0]).toBe('idempotency:anonymous:key-1');
  });

  it('stores a 2xx response so retries can replay it', async () => {
    fakeRedis.set.mockResolvedValue('OK');
    const res = makeRes();
    await run(makeReq(BODY, 'key-1'), res);

    res.status(201).json({ short_code: 'abc1234' });

    const [, numKeys, key, claimValue, completed, ttl] = fakeRedis.eval.mock.calls[0];
    expect([numKeys, key, ttl]).toEqual([1, 'idempotency:anonymous:key-1', 86400]);
    expect(JSON.parse(claimValue).state).toBe('processing');
    expect(JSON.parse(completed)).toMatchObject({
      state: 'completed',
      status: 201,
      body: { short_code: 'abc1234' },
      fingerprint: fingerprintOf(BODY),
    });
  });

  it('releases the claim after a non-2xx response so a retry re-executes', async () => {
    fakeRedis.set.mockResolvedValue('OK');
    const res = makeRes();
    await run(makeReq(BODY, 'key-1'), res);

    res.status(500).json({ error: 'Internal server error' });

    expect(fakeRedis.eval.mock.calls[0][4]).toBe(''); // empty value = delete
  });

  it('answers 409 with Retry-After while the original request is in flight', async () => {
    fakeRedis.set.mockResolvedValue(null);
    fakeRedis.get.mockResolvedValue(
      JSON.stringify({ state: 'processing', fingerprint: fingerprintOf(BODY), token: 't' })
    );
    const res = makeRes();
    const next = await run(makeReq(BODY, 'key-1'), res);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(409);
    expect(res.headers['Retry-After']).toBe('1');
  });

  it('replays the stored response for a retry with the same body', async () => {
    fakeRedis.set.mockResolvedValue(null);
    fakeRedis.get.mockResolvedValue(
      JSON.stringify({ state: 'completed', fingerprint: fingerprintOf(BODY), status: 201, body: { short_code: 'abc1234' } })
    );
    const res = makeRes();
    const next = await run(makeReq(BODY, 'key-1'), res);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual({ short_code: 'abc1234' });
    expect(res.headers['Idempotent-Replayed']).toBe('true');
  });

  it('answers 422 when the key is reused with a different body', async () => {
    fakeRedis.set.mockResolvedValue(null);
    fakeRedis.get.mockResolvedValue(
      JSON.stringify({ state: 'completed', fingerprint: fingerprintOf(BODY), status: 201, body: {} })
    );
    const res = makeRes();
    const next = await run(makeReq({ long_url: 'https://example.com/other' }, 'key-1'), res);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(422);
  });

  it('claims again if the stored record expired between SET NX and GET', async () => {
    fakeRedis.set.mockResolvedValueOnce(null).mockResolvedValueOnce('OK');
    fakeRedis.get.mockResolvedValue(null);
    const next = await run(makeReq(BODY, 'key-1'), makeRes());
    expect(next).toHaveBeenCalledTimes(1);
    expect(fakeRedis.set).toHaveBeenCalledTimes(2);
  });

  it('proceeds without protection if Redis errors mid-check', async () => {
    fakeRedis.set.mockRejectedValue(new Error('timeout'));
    const next = await run(makeReq(BODY, 'key-1'), makeRes());
    expect(next).toHaveBeenCalledTimes(1);
  });
});
