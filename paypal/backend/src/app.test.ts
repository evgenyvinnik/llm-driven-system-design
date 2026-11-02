import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createFakeClient, type FakeClient } from './test/fakeDb.js';

// bcrypt hash of "password123" (same as the seed).
const HASH = '$2b$10$p4U2V5CayiVxVMj8EJJ0peK3viI8RReSnMq3ou4SDoIbTbY4MNez6';
const ALICE = '11111111-1111-1111-1111-111111111111';
const BOB = '22222222-2222-2222-2222-222222222222';
const CAROL = '33333333-3333-3333-3333-333333333333';
const REQ = 'd0000000-0000-0000-0000-000000000001';

const mocks = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    // Just enough of ioredis for connect-redis sessions.
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => {
        store.set(k, v);
        return 'OK';
      },
      del: async (k: string) => (store.delete(k) ? 1 : 0),
      expire: async () => 1,
      call: async () => 'OK',
    },
    users: {} as Record<string, { id: string; username: string; role: string }>,
    client: null as unknown,
    executeTransfer: null as unknown as ReturnType<typeof import('vitest').vi.fn>,
  };
});

vi.mock('./services/redis.js', () => ({ redis: mocks.redis, connectRedis: vi.fn() }));
vi.mock('./services/db.js', () => ({
  pool: {
    query: vi.fn(async (sql: string, params: unknown[]) => {
      if (sql.includes('FROM users WHERE username')) {
        const u = mocks.users[params[0] as string];
        return { rows: u ? [{ ...u, email: `${u.username}@example.com`, display_name: u.username, password_hash: HASH }] : [] };
      }
      return { rows: [] };
    }),
    connect: vi.fn(async () => mocks.client),
  },
}));
vi.mock('./services/transferService.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/transferService.js')>();
  const { vi: v } = await import('vitest');
  mocks.executeTransfer = v.fn();
  return { ...actual, executeTransfer: mocks.executeTransfer };
});

import { app } from './app.js';

mocks.users = {
  alice: { id: ALICE, username: 'alice', role: 'user' },
  bob: { id: BOB, username: 'bob', role: 'user' },
  carol: { id: CAROL, username: 'carol', role: 'user' },
};

async function loginAs(username: string) {
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').send({ username, password: 'password123' });
  expect(res.status).toBe(200);
  return agent;
}

describe('auth', () => {
  it('issues a new session id on login (no session fixation)', async () => {
    const agent = request.agent(app);
    const first = await agent.post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    const second = await agent.post('/api/auth/login').send({ username: 'alice', password: 'password123' });
    const sid = (r: request.Response) => String(r.headers['set-cookie']).split(';')[0];
    expect(sid(first)).not.toBe(sid(second));
  });

  it('rejects money endpoints without a session', async () => {
    const res = await request(app).post('/api/transfers').send({ recipientId: BOB, amountCents: 100 });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/transfers validation', () => {
  beforeEach(() => {
    mocks.executeTransfer.mockReset();
  });

  it.each([
    ['a numeric string', '100'],
    ['a fraction of a cent', 1.5],
    ['zero', 0],
    ['a negative amount', -500],
    ['an array', [100]],
  ])('refuses %s with 400 before any money moves', async (_label, amountCents) => {
    const agent = await loginAs('alice');
    const res = await agent.post('/api/transfers').send({ recipientId: BOB, amountCents });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_AMOUNT');
    expect(mocks.executeTransfer).not.toHaveBeenCalled();
  });

  it('refuses amounts over the $50,000 cap', async () => {
    const agent = await loginAs('alice');
    const res = await agent.post('/api/transfers').send({ recipientId: BOB, amountCents: 5_000_001 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AMOUNT_OVER_LIMIT');
  });

  it('answers a malformed recipient id with 404 instead of a database error', async () => {
    const agent = await loginAs('alice');
    const res = await agent.post('/api/transfers').send({ recipientId: 'nope', amountCents: 100 });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Recipient not found');
  });

  it('passes the Idempotency-Key header through and flags replays', async () => {
    mocks.executeTransfer.mockResolvedValue({ result: { transaction: { id: 'tx-1' } }, replayed: true });
    const agent = await loginAs('alice');
    const res = await agent
      .post('/api/transfers')
      .set('Idempotency-Key', 'abc-123')
      .send({ recipientId: BOB, amountCents: 100 });
    expect(res.status).toBe(200);
    expect(res.headers['idempotent-replayed']).toBe('true');
    expect(mocks.executeTransfer).toHaveBeenCalledWith(
      expect.objectContaining({ senderId: ALICE, idempotencyKey: 'abc-123', amountCents: 100 }),
    );
  });

  it('never leaks internal error text', async () => {
    mocks.executeTransfer.mockRejectedValue(new Error('duplicate key value violates unique constraint'));
    const agent = await loginAs('alice');
    const res = await agent.post('/api/transfers').send({ recipientId: BOB, amountCents: 100 });
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
  });
});

describe('POST /api/wallet/deposit', () => {
  it('requires a linked payment method', async () => {
    const agent = await loginAs('alice');
    const res = await agent.post('/api/wallet/deposit').send({ amountCents: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PAYMENT_METHOD_REQUIRED');
  });
});

describe('money request actions', () => {
  let client: FakeClient;
  const pendingRequest = (overrides: Record<string, unknown> = {}) => ({
    id: REQ,
    requester_id: CAROL,
    payer_id: ALICE,
    amount_cents: '3000',
    status: 'pending',
    note: 'Utilities share',
    ...overrides,
  });

  beforeEach(() => {
    client = createFakeClient();
    mocks.client = client;
  });

  it('locks the request row and returns 404 to someone who is neither party', async () => {
    client.on(/FROM transfer_requests WHERE id = \$1 FOR UPDATE/, [pendingRequest()]);
    const agent = await loginAs('bob');
    for (const action of ['pay', 'decline', 'cancel']) {
      const res = await agent.post(`/api/requests/${REQ}/${action}`);
      expect(res.status).toBe(404);
    }
    expect(client.sqlLog().some((s) => s.startsWith('UPDATE'))).toBe(false);
  });

  it('refuses to pay a request twice (409) without moving money', async () => {
    client.on(/FOR UPDATE/, [pendingRequest({ status: 'paid' })]);
    const agent = await loginAs('alice');
    const res = await agent.post(`/api/requests/${REQ}/pay`);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Request is already paid');
    expect(client.sqlLog().some((s) => s.includes('FROM wallets'))).toBe(false);
    expect(client.sqlLog().at(-1)).toBe('ROLLBACK');
  });

  it('only the payer declines and only the requester cancels', async () => {
    client.on(/FOR UPDATE/, [pendingRequest()]);
    const carol = await loginAs('carol');
    expect((await carol.post(`/api/requests/${REQ}/decline`)).status).toBe(403);
    const alice = await loginAs('alice');
    expect((await alice.post(`/api/requests/${REQ}/cancel`)).status).toBe(403);
    expect((await carol.post(`/api/requests/${REQ}/pay`)).status).toBe(403);
  });

  it('pays inside one transaction: lock request, transfer, mark paid with the transaction id', async () => {
    client
      .on(/FROM transfer_requests WHERE id = \$1 FOR UPDATE/, [pendingRequest()])
      .on(/FROM wallets[\s\S]*FOR UPDATE/, [
        { id: 'wa', user_id: ALICE, balance_cents: '10000', version: 1 },
        { id: 'wc', user_id: CAROL, balance_cents: '0', version: 1 },
      ])
      .on(/balance_cents - \$1/, [{ balance_cents: '7000' }])
      .on(/balance_cents \+ \$1/, [{ balance_cents: '3000' }])
      .on(/INSERT INTO transactions/, [
        { id: 'tx-7', sender_id: ALICE, recipient_id: CAROL, amount_cents: '3000', type: 'transfer', status: 'completed', note: 'Utilities share', created_at: 'now' },
      ]);

    const agent = await loginAs('alice');
    const res = await agent.post(`/api/requests/${REQ}/pay`);

    expect(res.status).toBe(200);
    expect(res.body.request).toEqual({ id: REQ, status: 'paid', transactionId: 'tx-7' });
    const log = client.sqlLog();
    expect(log[0]).toBe('BEGIN');
    expect(log[1]).toMatch(/FROM transfer_requests WHERE id = \$1 FOR UPDATE/);
    const markPaid = client.calls.find((c) => c.sql.includes("SET status = 'paid'"))!;
    expect(markPaid.params).toEqual([REQ, 'tx-7']);
    expect(log.at(-1)).toBe('COMMIT');
  });

  it('rejects a request for more than the transfer cap', async () => {
    const agent = await loginAs('alice');
    const res = await agent.post('/api/requests').send({ payerId: BOB, amountCents: 10_000_000 });
    expect(res.status).toBe(400);
  });
});

describe('admin', () => {
  it('keeps reconciliation admin-only', async () => {
    const agent = await loginAs('alice');
    expect((await agent.get('/api/admin/reconciliation')).status).toBe(403);
  });
});
