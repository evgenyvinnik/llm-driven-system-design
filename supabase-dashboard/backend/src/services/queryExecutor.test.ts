import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/*
 * A fake `pg` that records what the executor sends. Each fake client answers
 * the server-identity probe with `state.targetServerId`; the metadata pool
 * answers with `state.metaServerId`, so making them equal simulates a project
 * pointed at the dashboard's own database.
 */
const state = vi.hoisted(() => ({
  pools: [] as Array<{
    options: Record<string, unknown>;
    ended: boolean;
    handlers: Record<string, (err: Error) => void>;
    connects: number;
  }>,
  clients: [] as Array<{ log: string[]; txStatus: string; released: unknown[] }>,
  targetServerId: '1700000000.111111',
  metaServerId: '1700000000.999999',
  connectError: null as Error | null,
  statementError: null as Error | null,
  cursor: null as null | ((client: { txStatus: string }, n: number) => { rows: unknown[]; error?: Error; command?: string }),
}));

vi.mock('pg', () => {
  class FakeClient {
    log: string[] = [];
    txStatus = 'I';
    released: unknown[] = [];
    constructor() {
      state.clients.push(this);
    }
    async connect() {
      if (state.connectError) throw state.connectError;
    }
    async end() {}
    release(arg?: unknown) {
      this.released.push(arg);
    }
    getTransactionStatus() {
      return this.txStatus;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query(q: any): any {
      if (q && typeof q === 'object' && q.isFakeCursor) {
        this.log.push(`CURSOR ${q.text}`);
        q.client = this;
        return q;
      }
      const text = typeof q === 'string' ? q : q.text;
      this.log.push(typeof q === 'string' ? text : `${q.queryMode ?? 'simple'}: ${text}`);
      if (/pg_postmaster_start_time/.test(text)) {
        return Promise.resolve({ rows: [{ server_id: state.targetServerId }] });
      }
      if (text === 'BEGIN READ ONLY') this.txStatus = 'T';
      if (text === 'ROLLBACK') this.txStatus = 'I';
      if (typeof q === 'object' && state.statementError) return Promise.reject(state.statementError);
      return Promise.resolve({ rows: [{ ok: 1 }], fields: [{ name: 'ok', dataTypeID: 23 }], rowCount: 1 });
    }
  }
  class FakePool {
    options: Record<string, unknown>;
    ended = false;
    handlers: Record<string, (err: Error) => void> = {};
    connects = 0;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      state.pools.push(this);
    }
    on(event: string, handler: (err: Error) => void) {
      this.handlers[event] = handler;
      return this;
    }
    async connect() {
      this.connects++;
      if (state.connectError) throw state.connectError;
      return new FakeClient();
    }
    async end() {
      this.ended = true;
    }
  }
  return { default: { Pool: FakePool, Client: FakeClient } };
});

vi.mock('pg-cursor', () => ({
  default: class FakeCursor {
    isFakeCursor = true;
    client: { txStatus: string } | null = null;
    constructor(public text: string) {}
    read(n: number, cb: (err: Error | undefined, rows: unknown[], result: unknown) => void) {
      setImmediate(() => {
        const out = state.cursor ? state.cursor(this.client!, n) : { rows: [] };
        if (out.error) cb(out.error, [], {});
        else cb(undefined, out.rows, { fields: [{ name: 'n', dataTypeID: 23 }], rowCount: out.rows.length, command: out.command ?? 'SELECT' });
      });
    }
    close() {
      return Promise.resolve();
    }
  },
}));

vi.mock('./db.js', () => ({
  pool: { query: vi.fn(async () => ({ rows: [{ server_id: state.metaServerId }] })) },
}));
vi.mock('./logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import {
  cleanupTargetPools,
  executeQuery,
  executeUserSql,
  getTargetPool,
  MetadataTargetError,
  pointsAtMetadataServer,
  removeTargetPool,
  TargetQueryError,
  TargetUnavailableError,
  testConnection,
} from './queryExecutor.js';

const CONFIG = { host: 'localhost', port: 5433, database: 'sample_db', user: 'sample', password: 'p@ss/word#1' };
let projectSeq = 0;
const nextProject = () => `project-${++projectSeq}`;

function sqlError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

beforeEach(() => {
  state.pools.length = 0;
  state.clients.length = 0;
  state.targetServerId = '1700000000.111111';
  state.connectError = null;
  state.statementError = null;
  state.cursor = null;
});

afterEach(async () => {
  await cleanupTargetPools();
});

describe('target pools', () => {
  it('connects with discrete fields, so a password with @ or / cannot redirect the host', () => {
    getTargetPool(nextProject(), CONFIG);
    const opts = state.pools[0].options;
    expect(opts).not.toHaveProperty('connectionString');
    expect(opts).toMatchObject({ host: 'localhost', port: 5433, user: 'sample', password: 'p@ss/word#1', max: 5 });
    expect(opts.statement_timeout).toBe(30000);
  });

  it('reuses a pool for unchanged settings and replaces it when they change', () => {
    const id = nextProject();
    const first = getTargetPool(id, CONFIG);
    expect(getTargetPool(id, { ...CONFIG })).toBe(first);

    const second = getTargetPool(id, { ...CONFIG, password: 'rotated' });
    expect(second).not.toBe(first);
    expect(state.pools[0].ended).toBe(true);
  });

  it('ignores late errors from a retired pool instead of evicting its replacement', () => {
    const id = nextProject();
    getTargetPool(id, CONFIG);
    const replacement = getTargetPool(id, { ...CONFIG, port: 5434 });
    state.pools[0].handlers.error(new Error('Connection terminated'));
    expect(getTargetPool(id, { ...CONFIG, port: 5434 })).toBe(replacement);
  });

  it('closes the pool when the project is removed', () => {
    const id = nextProject();
    getTargetPool(id, CONFIG);
    removeTargetPool(id);
    expect(state.pools[0].ended).toBe(true);
  });
});

describe('metadata-server guard', () => {
  it('refuses a target that turns out to be the metadata server, and drops its pool', async () => {
    state.targetServerId = '1700000000.999999';
    const id = nextProject();
    await expect(executeQuery(id, CONFIG, 'SELECT 1')).rejects.toBeInstanceOf(MetadataTargetError);
    expect(state.pools[0].ended).toBe(true);
    // No statement reached it.
    expect(state.clients[0].log.some((l) => l.includes('SELECT 1'))).toBe(false);
  });

  it('flags the obvious host:port alias at save time', () => {
    expect(pointsAtMetadataServer('localhost', 5432)).toBe(true);
    expect(pointsAtMetadataServer('127.0.0.1', 5432)).toBe(true);
    expect(pointsAtMetadataServer('[::1]', 5432)).toBe(true);
    expect(pointsAtMetadataServer('localhost', 5433)).toBe(false);
    expect(pointsAtMetadataServer('db.example.com', 5432)).toBe(false);
  });

  it('fails the connection test for the metadata server', async () => {
    state.targetServerId = '1700000000.999999';
    const result = await testConnection(CONFIG);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/metadata database/);
  });
});

describe('circuit breaker', () => {
  it('opens after repeated connection failures and then fails fast', async () => {
    const id = nextProject();
    state.connectError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' });
    for (let i = 0; i < 3; i++) {
      await expect(executeQuery(id, CONFIG, 'SELECT 1')).rejects.toBeInstanceOf(TargetUnavailableError);
    }
    const err = await executeQuery(id, CONFIG, 'SELECT 1').catch((e) => e);
    expect(err).toBeInstanceOf(TargetUnavailableError);
    expect(err.status).toBe(503);
    expect(err.message).toMatch(/circuit breaker/);
    expect(state.pools[0].connects).toBe(3); // the 4th call never tried to connect
  });

  it('does not count statement errors: a typo-prone user cannot open the circuit', async () => {
    const id = nextProject();
    state.statementError = sqlError('42601', 'syntax error at or near "SELEC"');
    for (let i = 0; i < 6; i++) {
      const err = await executeQuery(id, CONFIG, 'SELEC 1').catch((e) => e);
      expect(err).toBeInstanceOf(TargetQueryError);
      expect(err.status).toBe(400);
    }
    expect(state.pools[0].connects).toBe(6);
  });
});

describe('generated statements', () => {
  it('are sent as single prepared statements with bound values', async () => {
    await executeQuery(nextProject(), CONFIG, 'DELETE FROM "public"."t" WHERE "id" = $1', ['7']);
    expect(state.clients[0].log).toContain('extended: DELETE FROM "public"."t" WHERE "id" = $1');
  });
});

describe('user SQL', () => {
  it('runs viewers inside a READ ONLY transaction and resets the session afterwards', async () => {
    state.cursor = () => ({ rows: [{ n: 1 }] });
    const out = await executeUserSql(nextProject(), CONFIG, 'SELECT count(*) FROM orders', { readOnly: true });
    expect(out.rows).toEqual([{ n: 1 }]);
    const log = state.clients[0].log.filter((l) => !l.includes('pg_postmaster_start_time'));
    expect(log).toEqual(['BEGIN READ ONLY', 'SELECT 1', 'CURSOR SELECT count(*) FROM orders', 'ROLLBACK', 'DISCARD ALL']);
  });

  it('caps returned rows and says so', async () => {
    state.cursor = (_client, n) => ({ rows: Array.from({ length: n }, (_, i) => ({ n: i })) });
    const out = await executeUserSql(nextProject(), CONFIG, 'SELECT * FROM big', { readOnly: false, maxRows: 10 });
    expect(out.rows).toHaveLength(10);
    expect(out.truncated).toBe(true);
  });

  it('rolls back a transaction left open across requests and tells the user', async () => {
    state.cursor = (client) => {
      client.txStatus = 'T'; // the user's statement was BEGIN
      return { rows: [], command: 'BEGIN' };
    };
    const err = await executeUserSql(nextProject(), CONFIG, 'BEGIN', { readOnly: false }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/cannot span requests/);
    expect(state.clients[0].log.slice(-2)).toEqual(['ROLLBACK', 'DISCARD ALL']);
  });

  it('explains the one-statement rule when given a batch', async () => {
    state.cursor = () => ({ rows: [], error: sqlError('42601', 'cannot insert multiple commands into a prepared statement') });
    const err = await executeUserSql(nextProject(), CONFIG, 'SELECT 1; SELECT 2', { readOnly: false }).catch((e) => e);
    expect(err).toBeInstanceOf(TargetQueryError);
    expect(err.message).toMatch(/one statement at a time/);
    expect(state.clients[0].log).toContain('DISCARD ALL');
  });
});
