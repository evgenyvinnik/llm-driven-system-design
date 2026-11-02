import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';

// Mock shared modules before importing the app.
vi.mock('./services/db.js', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock('./services/redis.js', () => ({
  redis: {},
  connectRedis: vi.fn(),
}));
// Sessions live in memory for tests instead of Valkey.
vi.mock('connect-redis', async () => {
  const session = await import('express-session');
  return { default: session.MemoryStore };
});

import { app } from './app.js';
import { pool } from './services/db.js';

const query = pool.query as unknown as ReturnType<typeof vi.fn>;

const ALICE = { id: 'a1111111-1111-1111-1111-111111111111', username: 'alice', role: 'admin' };
const BOB = { id: 'b2222222-2222-2222-2222-222222222222', username: 'bob', role: 'user' };
const ALICE_ACCOUNT = 'acc00001-0000-0000-0000-000000000001';
const BOB_OPP = '0bb00009-0000-0000-0000-000000000009';

let passwordHash = '';

beforeAll(async () => {
  passwordHash = await bcrypt.hash('password123', 4);
});

beforeEach(() => {
  query.mockReset();
});

/** A supertest agent holding a session for `user`. */
async function signIn(user: typeof ALICE) {
  const agent = request.agent(app);
  query.mockResolvedValueOnce({
    rows: [{ ...user, email: `${user.username}@example.com`, display_name: user.username, password_hash: passwordHash }],
  });
  const res = await agent.post('/api/auth/login').send({ username: user.username, password: 'password123' });
  expect(res.status).toBe(200);
  query.mockReset();
  return agent;
}

/** The SQL text and params of the nth pool.query call. */
function call(n: number): { sql: string; params: unknown[] } {
  const [sql, params] = query.mock.calls[n];
  return { sql: String(sql), params: (params as unknown[]) ?? [] };
}

describe('authentication', () => {
  it('rejects unauthenticated data requests', async () => {
    const res = await request(app).get('/api/accounts');
    expect(res.status).toBe(401);
  });

  it('issues a new session id on every login (no session fixation)', async () => {
    const agent = request.agent(app);
    const userRow = { rows: [{ ...BOB, email: 'b@x', display_name: 'Bob', password_hash: passwordHash }] };
    const sid = (res: request.Response) => String(res.headers['set-cookie'] ?? '').split(';')[0];

    query.mockResolvedValueOnce(userRow);
    const first = await agent.post('/api/auth/login').send({ username: 'bob', password: 'password123' });
    query.mockResolvedValueOnce(userRow);
    const second = await agent.post('/api/auth/login').send({ username: 'bob', password: 'password123' });

    expect(sid(first)).toMatch(/^connect\.sid=/);
    expect(sid(second)).toMatch(/^connect\.sid=/);
    expect(sid(second)).not.toBe(sid(first));
  });
});

describe('record-level access', () => {
  it('limits a rep\'s account list to records they own', async () => {
    const bob = await signIn(BOB);
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: 0 }] });
    const res = await bob.get('/api/accounts');
    expect(res.status).toBe(200);
    expect(call(0).sql).toMatch(/a\.owner_id = \$1/);
    expect(call(0).params[0]).toBe(BOB.id);
    expect(call(1).sql).toMatch(/a\.owner_id = \$1/);
  });

  it('gives an admin the unfiltered list', async () => {
    const alice = await signIn(ALICE);
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: 0 }] });
    await alice.get('/api/accounts');
    expect(call(0).sql).not.toMatch(/owner_id = \$/);
  });

  it("returns 404 (not 403) for another rep's account", async () => {
    const bob = await signIn(BOB);
    query.mockResolvedValueOnce({ rows: [{ id: ALICE_ACCOUNT, owner_id: ALICE.id }] });
    const res = await bob.get(`/api/accounts/${ALICE_ACCOUNT}`);
    expect(res.status).toBe(404);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("hides another rep's account's contacts and timeline behind the same 404", async () => {
    const bob = await signIn(BOB);
    query.mockResolvedValue({ rows: [{ id: ALICE_ACCOUNT, owner_id: ALICE.id }] });
    expect((await bob.get(`/api/accounts/${ALICE_ACCOUNT}/contacts`)).status).toBe(404);
    expect((await bob.get(`/api/activities?relatedType=account&relatedId=${ALICE_ACCOUNT}`)).status).toBe(404);
  });

  it('puts the ownership check inside the UPDATE and DELETE statements', async () => {
    const bob = await signIn(BOB);
    query.mockResolvedValue({ rows: [] });
    expect((await bob.put(`/api/accounts/${ALICE_ACCOUNT}`).send({ name: 'Mine now' })).status).toBe(404);
    expect(call(0).sql).toMatch(/WHERE id = \$11 AND accounts\.owner_id = \$12/);
    expect(call(0).params[11]).toBe(BOB.id);
    expect((await bob.delete(`/api/accounts/${ALICE_ACCOUNT}`)).status).toBe(404);
    expect(call(1).sql).toMatch(/accounts\.owner_id = \$2/);
  });

  it('answers malformed ids with 404 without querying Postgres', async () => {
    const bob = await signIn(BOB);
    expect((await bob.get('/api/accounts/not-a-uuid')).status).toBe(404);
    expect((await bob.delete('/api/leads/42')).status).toBe(404);
    expect(query).not.toHaveBeenCalled();
  });

  it("refuses to attach a contact to another rep's account", async () => {
    const bob = await signIn(BOB);
    query.mockResolvedValueOnce({ rows: [{ id: ALICE_ACCOUNT, owner_id: ALICE.id }] });
    const res = await bob.post('/api/contacts').send({ firstName: 'X', lastName: 'Y', accountId: ALICE_ACCOUNT });
    expect(res.status).toBe(400);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe('opportunity stage integrity', () => {
  it('stops a rep reopening a closed-won deal, but lets an admin', async () => {
    const bob = await signIn(BOB);
    query.mockResolvedValueOnce({ rows: [{ id: BOB_OPP, stage: 'Closed Won', probability: 100, owner_id: BOB.id }] });
    const refused = await bob.put(`/api/opportunities/${BOB_OPP}/stage`).send({ stage: 'Prospecting' });
    expect(refused.status).toBe(409);

    const alice = await signIn(ALICE);
    query
      .mockResolvedValueOnce({ rows: [{ id: BOB_OPP, stage: 'Closed Won', probability: 100, owner_id: BOB.id }] })
      .mockResolvedValueOnce({ rows: [{ id: BOB_OPP, stage: 'Prospecting', probability: 10 }] });
    const reopened = await alice.put(`/api/opportunities/${BOB_OPP}/stage`).send({ stage: 'Prospecting' });
    expect(reopened.status).toBe(200);
    // Compare-and-set on the stage the plan was computed from; closed_at cleared.
    expect(call(1).sql).toMatch(/closed_at = NULL/);
    expect(call(1).sql).toMatch(/AND stage = \$4/);
    expect(call(1).params).toEqual(['Prospecting', 10, BOB_OPP, 'Closed Won']);
  });

  it('returns 409 when the stage changed between read and write', async () => {
    const bob = await signIn(BOB);
    query
      .mockResolvedValueOnce({ rows: [{ id: BOB_OPP, stage: 'Proposal', probability: 60, owner_id: BOB.id }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await bob.put(`/api/opportunities/${BOB_OPP}/stage`).send({ stage: 'Negotiation' });
    expect(res.status).toBe(409);
  });

  it('rejects fractional cents instead of letting Postgres 500', async () => {
    const bob = await signIn(BOB);
    const res = await bob.post('/api/opportunities').send({ name: 'Deal', amountCents: '12.5' });
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe('leads', () => {
  it("won't let a lead be marked Converted without converting it", async () => {
    const bob = await signIn(BOB);
    const res = await bob.post('/api/leads').send({ firstName: 'A', lastName: 'B', status: 'Converted' });
    expect(res.status).toBe(400);
  });

  it('treats converted leads as read-only', async () => {
    const bob = await signIn(BOB);
    const id = '1ead0003-0000-0000-0000-000000000003';
    query
      .mockResolvedValueOnce({ rows: [{ id, owner_id: BOB.id }] })
      .mockResolvedValueOnce({ rows: [] });
    const res = await bob.put(`/api/leads/${id}`).send({ company: 'Renamed' });
    expect(res.status).toBe(409);
    expect(call(1).sql).toMatch(/converted_at IS NULL/);
  });
});

describe('reports', () => {
  it('clamps ?all=true to the caller\'s own records for reps', async () => {
    const bob = await signIn(BOB);
    query.mockResolvedValueOnce({ rows: [] });
    const res = await bob.get('/api/reports/pipeline?all=true');
    expect(res.body.scope).toBe('own');
    expect(call(0).params).toEqual([BOB.id]);
  });

  it('gives admins the org-wide view on request', async () => {
    const alice = await signIn(ALICE);
    query.mockResolvedValueOnce({ rows: [] });
    const res = await alice.get('/api/reports/pipeline?all=true');
    expect(res.body.scope).toBe('org');
    expect(call(0).params).toEqual([]);
  });

  it('clamps bad pagination and month values instead of passing NaN to Postgres', async () => {
    const bob = await signIn(BOB);
    query.mockResolvedValueOnce({ rows: [] });
    await bob.get('/api/reports/revenue?months=abc');
    expect(call(0).params[0]).toBe(12);

    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ count: 0 }] });
    await bob.get('/api/leads?page=abc&limit=-5');
    expect(call(1).params.slice(-2)).toEqual([20, 0]);
  });
});

describe('observability', () => {
  it('records request metrics labelled by route pattern', async () => {
    await request(app).get('/api/accounts');
    const res = await request(app).get('/metrics');
    expect(res.text).toContain('http_requests_total{method="GET",route="/api/accounts",status_code="401"}');
  });
});

describe('report rate limiting', () => {
  it('budgets report requests per user, not per IP', async () => {
    const alice = await signIn(ALICE);
    const bob = await signIn(BOB);
    query.mockResolvedValue({ rows: [] });
    // Exhaust alice's per-minute budget; bob, on the same IP, is unaffected.
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await alice.get('/api/reports/leads')).status;
    expect(last).toBe(429);
    expect((await bob.get('/api/reports/leads')).status).toBe(200);
  });
});
