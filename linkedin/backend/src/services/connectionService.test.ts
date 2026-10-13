import { describe, it, expect, vi, beforeEach } from 'vitest';

interface FakeResult { rows: Record<string, unknown>[]; rowCount: number }
type Responder = (sql: string, params: unknown[]) => FakeResult | undefined;
let respond: Responder;
const statements: string[] = [];
const client = {
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    statements.push(sql.replace(/\s+/g, ' ').trim());
    return respond(sql, params) ?? { rows: [], rowCount: 0 };
  }),
};

vi.mock('../utils/db.js', () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTransaction: vi.fn(async (fn: (c: typeof client) => Promise<unknown>) => fn(client)),
}));
vi.mock('../utils/redis.js', () => ({ cacheDel: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../utils/graphCache.js', () => ({ getCachedFirstDegree: vi.fn(), bumpGraphVersion: vi.fn() }));
vi.mock('./userService.js', () => ({ getUsersByIds: vi.fn(), getUserSummaries: vi.fn() }));
vi.mock('../utils/logger.js', () => ({ logger: { warn: vi.fn() } }));

import { bumpGraphVersion } from '../utils/graphCache.js';
import { acceptConnectionRequest, sendConnectionRequest } from './connectionService.js';

const rows = (...r: Record<string, unknown>[]): FakeResult => ({ rows: r, rowCount: r.length });

beforeEach(() => {
  statements.length = 0;
  vi.mocked(bumpGraphVersion).mockClear();
});

describe('acceptConnectionRequest', () => {
  it('treats a repeated accept as success without touching counters', async () => {
    respond = (sql) => {
      if (sql.includes('SELECT from_user_id, to_user_id')) return rows({ from_user_id: 4, to_user_id: 5 });
      if (sql.includes("status = 'accepted', updated_at = NOW()") && sql.includes('RETURNING')) return rows();
      if (sql.includes('SELECT * FROM connection_requests')) {
        return rows({ id: 1, from_user_id: 4, to_user_id: 5, status: 'accepted' });
      }
      if (sql.includes('SELECT 1 FROM connections')) return rows({ '?column?': 1 });
      return undefined;
    };
    const result = await acceptConnectionRequest(1, 5);
    expect(result.changed).toBe(false);
    expect(statements.some((s) => s.includes('pg_advisory_xact_lock'))).toBe(true);
    expect(statements.some((s) => s.includes('connection_count'))).toBe(false);
    expect(bumpGraphVersion).not.toHaveBeenCalled();
  });

  it('creates the edge and moves both counters once on the first accept', async () => {
    respond = (sql) => {
      if (sql.includes('SELECT from_user_id, to_user_id')) return rows({ from_user_id: 4, to_user_id: 5 });
      if (sql.includes("WHERE id = $1 AND to_user_id = $2 AND status = 'pending'")) {
        return rows({ id: 1, from_user_id: 4, to_user_id: 5, status: 'accepted' });
      }
      if (sql.includes('INSERT INTO connections')) return { rows: [], rowCount: 1 };
      return undefined;
    };
    const result = await acceptConnectionRequest(1, 5);
    expect(result.changed).toBe(true);
    expect(statements.filter((s) => s.includes('connection_count = connection_count + 1'))).toHaveLength(1);
    expect(bumpGraphVersion).toHaveBeenCalledWith([4, 5]);
  });
});

describe('sendConnectionRequest', () => {
  it('rejects inviting yourself before opening a transaction', async () => {
    await expect(sendConnectionRequest(3, 3)).rejects.toMatchObject({ status: 400 });
    expect(statements).toHaveLength(0);
  });

  it('accepts a crossing invitation instead of creating a second one', async () => {
    respond = (sql) => {
      if (sql.includes('SELECT 1 FROM users')) return rows({ '?column?': 1 });
      if (sql.includes('SELECT id FROM connection_requests')) return rows({ id: 42 });
      if (sql.includes("WHERE id = $1 AND to_user_id = $2 AND status = 'pending'")) {
        return rows({ id: 42, from_user_id: 9, to_user_id: 1, status: 'accepted' });
      }
      if (sql.includes('INSERT INTO connections')) return { rows: [], rowCount: 1 };
      return undefined;
    };
    const result = await sendConnectionRequest(1, 9);
    expect(result.outcome).toBe('accepted_reverse');
    expect(statements.some((s) => s.startsWith('INSERT INTO connection_requests'))).toBe(false);
    expect(bumpGraphVersion).toHaveBeenCalledWith([1, 9]);
  });

  it('refuses when the two members are already connected', async () => {
    respond = (sql) => {
      if (sql.includes('SELECT 1 FROM users')) return rows({ '?column?': 1 });
      if (sql.includes('SELECT 1 FROM connections')) return rows({ '?column?': 1 });
      return undefined;
    };
    await expect(sendConnectionRequest(1, 2)).rejects.toMatchObject({ status: 409, code: 'already_connected' });
  });
});
