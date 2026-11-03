import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';

/*
 * Route-level authorization checks against a fake metadata database:
 * alice owns project P1, bob is an editor, vera a viewer, carol an outsider.
 * Target-database access is stubbed, so these tests show which calls are
 * allowed to reach it at all, and with what.
 */

const ids = vi.hoisted(() => ({
  P1: '9a000001-0000-0000-0000-000000000001',
  alice: 'a1111111-1111-1111-1111-111111111111',
  bob: 'b2222222-2222-2222-2222-222222222222',
  vera: 'd4444444-4444-4444-4444-444444444444',
  carol: 'c3333333-3333-3333-3333-333333333333',
}));

const db = vi.hoisted(() => ({
  hash: '',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  extra: null as null | ((sql: string, params: any[]) => { rows: any[]; rowCount?: number } | undefined),
}));

vi.mock('./services/db.js', () => {
  const users: Record<string, { id: string; role: string }> = {
    alice: { id: ids.alice, role: 'admin' },
    bob: { id: ids.bob, role: 'user' },
    vera: { id: ids.vera, role: 'user' },
    carol: { id: ids.carol, role: 'user' },
  };
  const members: Record<string, string> = { [ids.bob]: 'editor', [ids.vera]: 'viewer' };
  const projectRow = {
    id: ids.P1,
    name: 'Storefront Production',
    description: null,
    db_host: 'localhost',
    db_port: 5433,
    db_name: 'sample_db',
    db_user: 'sample',
    db_password: 'sample123',
    created_by: ids.alice,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function query(sql: string, params: any[] = []) {
    const custom = db.extra?.(sql, params);
    if (custom) return { rowCount: custom.rows.length, ...custom };
    if (/FROM users WHERE username = \$1/.test(sql) && /password_hash/.test(sql)) {
      const u = users[params[0]];
      return { rows: u ? [{ ...u, username: params[0], email: `${params[0]}@x.io`, password_hash: db.hash, display_name: params[0] }] : [] };
    }
    if (/LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = \$2/.test(sql)) {
      return params[0] === ids.P1 ? { rows: [{ ...projectRow, member_role: members[params[1]] ?? null }] } : { rows: [] };
    }
    if (/WHERE p.created_by = \$1 OR pm.user_id = \$1/.test(sql)) {
      const role = params[0] === ids.alice ? 'owner' : members[params[0]];
      return { rows: role ? [{ ...projectRow, member_role: role }] : [] };
    }
    if (/FROM projects\s+WHERE id = \$1/.test(sql) || /FOR UPDATE/.test(sql)) {
      return { rows: [projectRow] };
    }
    return { rows: [], rowCount: 0 };
  }
  const client = { query, release: () => {} };
  return { pool: { query: vi.fn(query), connect: vi.fn(async () => client) } };
});

vi.mock('./services/redis.js', () => ({ redis: {}, connectRedis: vi.fn() }));
vi.mock('connect-redis', async () => {
  const session = (await import('express-session')).default;
  return { default: class extends session.MemoryStore {} };
});
vi.mock('./services/queryExecutor.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./services/queryExecutor.js')>();
  return {
    ...actual,
    executeUserSql: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0, command: 'SELECT', truncated: false })),
    executeQuery: vi.fn(async () => ({ rows: [], fields: [], rowCount: 0 })),
    withTargetClient: vi.fn(),
    testConnection: vi.fn(async () => ({ success: true })),
    removeTargetPool: vi.fn(),
    resetCircuit: vi.fn(),
  };
});

import { app } from './app.js';
import { executeQuery, executeUserSql, withTargetClient } from './services/queryExecutor.js';
import { pool } from './services/db.js';

type Agent = ReturnType<typeof request.agent>;
const agents: Record<string, Agent> = {};
const P = `/api/projects/${ids.P1}`;

beforeAll(async () => {
  db.hash = await bcrypt.hash('password123', 4);
  for (const name of ['alice', 'bob', 'vera', 'carol']) {
    agents[name] = request.agent(app);
    const res = await agents[name].post('/api/auth/login').send({ username: name, password: 'password123' });
    expect(res.status).toBe(200);
  }
});

beforeEach(() => {
  db.extra = null;
  vi.mocked(executeQuery).mockClear();
  vi.mocked(executeUserSql).mockClear();
  vi.mocked(withTargetClient).mockReset();
});

describe('authentication', () => {
  it('requires a session for project routes', async () => {
    expect((await request(app).get(`${P}/tables`)).status).toBe(401);
    expect((await request(app).post(`${P}/sql/execute`).send({ sql: 'SELECT 1' })).status).toBe(401);
  });
});

describe('a user with no role in the project (carol)', () => {
  it.each([
    ['get', ''],
    ['get', '/tables'],
    ['get', '/tables/products/rows'],
    ['get', '/sql/saved'],
    ['get', '/auth-users'],
    ['get', '/settings'],
    ['get', '/members'],
    ['post', '/test-connection'],
  ])('%s %s → 404', async (method, path) => {
    const res = await (agents.carol as unknown as Record<string, (p: string) => request.Test>)[method](`${P}${path}`);
    expect(res.status).toBe(404);
  });

  it('cannot run SQL against the project or read its credentials', async () => {
    const res = await agents.carol.post(`${P}/sql/execute`).send({ sql: 'SELECT * FROM customers' });
    expect(res.status).toBe(404);
    expect(executeUserSql).not.toHaveBeenCalled();
  });

  it('cannot add herself as an owner', async () => {
    const res = await agents.carol.post(`${P}/members`).send({ userId: ids.carol, role: 'owner' });
    expect(res.status).toBe(404);
    expect(vi.mocked(pool.query).mock.calls.some(([sql]) => /INSERT INTO project_members/.test(String(sql)))).toBe(false);
  });

  it('does not see the project in her list', async () => {
    const res = await agents.carol.get('/api/projects');
    expect(res.body.projects).toEqual([]);
  });
});

describe('viewer (vera)', () => {
  it('can read but not change the project', async () => {
    expect((await agents.vera.get(`${P}/settings`)).status).toBe(200);
    expect((await agents.vera.post(`${P}/tables`).send({ tableName: 't', columns: [{ name: 'a', type: 'INT' }] })).status).toBe(403);
    expect((await agents.vera.delete(`${P}/tables/products`)).status).toBe(403);
    expect((await agents.vera.post(`${P}/tables/products/rows`).send({ data: { name: 'x' } })).status).toBe(403);
    expect((await agents.vera.post(`${P}/sql/saved`).send({ name: 'q', queryText: 'SELECT 1' })).status).toBe(403);
    expect((await agents.vera.post(`${P}/auth-users`).send({ email: 'a@b.co', password: 'secret1' })).status).toBe(403);
    expect((await agents.vera.put(`${P}/settings`).send({ name: 'x' })).status).toBe(403);
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('runs SQL read-only', async () => {
    const res = await agents.vera.post(`${P}/sql/execute`).send({ sql: 'SELECT 1' });
    expect(res.status).toBe(200);
    expect(res.body.readOnly).toBe(true);
    expect(vi.mocked(executeUserSql).mock.calls[0][3]).toEqual({ readOnly: true });
  });
});

describe('editor (bob)', () => {
  it('runs SQL with write access but cannot administer the project', async () => {
    const res = await agents.bob.post(`${P}/sql/execute`).send({ sql: 'UPDATE products SET stock = 1' });
    expect(res.status).toBe(200);
    expect(vi.mocked(executeUserSql).mock.calls[0][3]).toEqual({ readOnly: false });

    expect((await agents.bob.put(`${P}/settings`).send({ dbHost: 'evil.example' })).status).toBe(403);
    expect((await agents.bob.post(`${P}/members`).send({ userId: ids.carol, role: 'viewer' })).status).toBe(403);
    expect((await agents.bob.delete(P)).status).toBe(403);
  });

  it('may leave the project but not remove others', async () => {
    expect((await agents.bob.delete(`${P}/members/${ids.vera}`)).status).toBe(403);
  });
});

describe('owner (alice)', () => {
  it('never receives the database password', async () => {
    for (const res of [
      await agents.alice.get('/api/projects'),
      await agents.alice.get(P),
      await agents.alice.get(`${P}/settings`),
    ]) {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toMatch(/sample123|password/i);
    }
    expect((await agents.alice.get(P)).body.project.memberRole).toBe('owner');
  });

  it("cannot point a project at the dashboard's metadata database", async () => {
    const res = await agents.alice.put(`${P}/settings`).send({ dbHost: 'localhost', dbPort: 5432 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metadata database/);

    const created = await agents.alice.post('/api/projects').send({ name: 'x', dbHost: '127.0.0.1', dbPort: 5432 });
    expect(created.status).toBe(400);
  });

  it('validates member roles and protects the creator', async () => {
    db.extra = (sql) => (/FROM users WHERE id = \$1/.test(sql) ? { rows: [{ id: ids.alice, username: 'alice' }] } : undefined);
    expect((await agents.alice.post(`${P}/members`).send({ userId: ids.carol, role: 'admin' })).status).toBe(400);
    expect((await agents.alice.post(`${P}/members`).send({ userId: ids.alice, role: 'viewer' })).status).toBe(400);
    expect((await agents.alice.delete(`${P}/members/${ids.alice}`)).status).toBe(400);
  });
});

describe('table data', () => {
  /** A fake target client answering the table lookup, recording statements. */
  function stubTarget(columns: { name: string; pk: boolean }[]) {
    const statements: { text: string; values: unknown[] }[] = [];
    const client = {
      query: vi.fn(async (q: string | { text: string; values: unknown[] }) => {
        if (typeof q === 'string' || !('queryMode' in q)) {
          return { rows: columns.map((c) => ({ column_name: c.name, is_pk: c.pk })) };
        }
        statements.push({ text: q.text, values: q.values });
        return { rows: [{ id: 7 }], rowCount: 1, fields: [] };
      }),
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(withTargetClient).mockImplementation(async (_p, _c, fn: any) => fn(client));
    return statements;
  }

  it('updates by the real primary key with bound values and quoted identifiers', async () => {
    const statements = stubTarget([
      { name: 'id', pk: true },
      { name: 'name', pk: false },
    ]);
    const res = await agents.bob
      .put(`${P}/tables/products/rows/7`)
      .send({ data: { name: "O'Reilly'); DROP TABLE products; --" }, primaryKey: 'name' });
    expect(res.status).toBe(200);
    expect(statements).toEqual([
      {
        text: 'UPDATE "public"."products" SET "name" = $1 WHERE "id" = $2 RETURNING *',
        values: ["O'Reilly'); DROP TABLE products; --", '7'],
      },
    ]);
  });

  it('refuses row edits on tables without a single-column primary key', async () => {
    stubTarget([
      { name: 'order_id', pk: true },
      { name: 'product_id', pk: true },
    ]);
    const res = await agents.bob.delete(`${P}/tables/order_items/rows/1`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/composite primary key/);
  });

  it('rejects unknown columns before touching the table', async () => {
    const statements = stubTarget([{ name: 'id', pk: true }]);
    const res = await agents.bob.post(`${P}/tables/products/rows`).send({ data: { 'id"; DROP': 1 } });
    expect(res.status).toBe(400);
    expect(statements).toEqual([]);
  });
});
