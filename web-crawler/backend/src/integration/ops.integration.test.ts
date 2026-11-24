/**
 * Operations integration tests against real PostgreSQL + Redis:
 * the audit trail, the auth-state cache behind session checks, and CDN
 * exemptions from the per-IP lock.
 *
 * Opt-in: `npm run test:integration`. FLUSHES Redis and TRUNCATES crawler tables.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const enabled = process.env.INTEGRATION === '1';

// Config is read at import time. Fixture list servers listen on these ports.
process.env.CRAWLER_IP_DELAY_MS = '1000';
process.env.CRAWLER_MAX_PAGES_PER_DOMAIN = '1000';
process.env.CRAWLER_IP_EXEMPT_CIDRS = '127.0.0.3/32';
process.env.CRAWLER_IP_EXEMPT_SOURCES = [
  'http://127.0.0.1:18121/ips-v4',
  'http://127.0.0.1:18122/public-ip-list',
  'http://127.0.0.1:18123/flaky',
].join(',');

describe.skipIf(!enabled)('operations end-to-end', () => {
  let server: Server;
  const fixtures: Server[] = [];
  let flakyCalls = 0;
  let base: string;
  let admin = '';
  let m: {
    pool: typeof import('../models/database.js').pool;
    redis: typeof import('../models/redis.js').redis;
    REDIS_KEYS: typeof import('../models/redis.js').REDIS_KEYS;
    frontier: typeof import('../services/frontier.js').frontierService;
    users: typeof import('../services/users.js');
    audit: typeof import('../services/audit.js');
    ipPolicy: typeof import('../services/ipPolicy.js');
  };

  const call = async (method: string, path: string, body?: unknown, cookie = '') => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ops-test', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      // empty body
    }
    return { status: res.status, json, headers: res.headers };
  };
  const resetLoginLimit = () =>
    m.redis.del('crawler:ratelimit:login:127.0.0.1', 'crawler:ratelimit:login:::ffff:127.0.0.1');
  const login = async (username: string, password: string) => {
    await resetLoginLimit();
    const res = await call('POST', '/api/auth/login', { username, password });
    expect(res.status, `login ${username}`).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  };
  const me = async (cookie: string) => (await call('GET', '/api/auth/me', undefined, cookie)).json;
  const listen = (port: number, handler: http.RequestListener) =>
    new Promise<void>((resolve) => {
      const s = http.createServer(handler).listen(port, '127.0.0.1', () => resolve());
      fixtures.push(s);
    });

  beforeAll(async () => {
    // Published-list fixtures: plain text, provider-style JSON, and one that
    // works once and then fails
    await listen(18121, (_req, res) => res.end('# ranges\n127.0.0.4/32\n2001:db8::/32\n'));
    await listen(18122, (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ addresses: ['10.0.0.0/8'], ipv6_addresses: ['2001:db8:ffff::/48'] }));
    });
    await listen(18123, (_req, res) => {
      flakyCalls++;
      if (flakyCalls === 1) return res.end('192.0.2.0/24\n');
      res.statusCode = 500;
      res.end('boom');
    });

    const db = await import('../models/database.js');
    const r = await import('../models/redis.js');
    await db.initDatabase();
    await db.pool.query('TRUNCATE url_frontier, crawled_pages, domains, audit_log, users RESTART IDENTITY');
    await r.redis.flushdb();

    const users = await import('../services/users.js');
    await users.ensureBootstrapAdmin();
    const { app } = await import('../server.js');
    m = {
      pool: db.pool,
      redis: r.redis,
      REDIS_KEYS: r.REDIS_KEYS,
      frontier: (await import('../services/frontier.js')).frontierService,
      users,
      audit: await import('../services/audit.js'),
      ipPolicy: await import('../services/ipPolicy.js'),
    };
    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    await m.pool.query(`INSERT INTO domains (domain, robots_txt, crawl_delay) VALUES ('audit.example', '', 1)`);
  });

  afterAll(async () => {
    if (!enabled) return;
    await new Promise((resolve) => server.close(resolve));
    await Promise.all(fixtures.map((s) => new Promise((resolve) => s.close(resolve))));
    await m.pool.end();
    await m.redis.quit();
  });

  // -------------------------------------------------------------------------
  // Audit trail
  // -------------------------------------------------------------------------

  it('records the bootstrap, sign-ins (including failures), and admin actions', async () => {
    await resetLoginLimit();
    expect((await call('POST', '/api/auth/login', { username: 'admin', password: 'nope-nope' })).status).toBe(401);
    admin = await login('admin', 'password123');

    const created = await call('POST', '/api/admin/users', { username: 'auditee', password: 'initial-pass', role: 'user' }, admin);
    const auditeeId = created.json.id as number;
    await call('PATCH', `/api/admin/users/${auditeeId}`, { password: 'secret-pass-xyz' }, admin);
    await call('POST', '/api/frontier/seed', { urls: ['https://seed.example/'] }, admin);
    await call('PUT', '/api/domains/audit.example/settings', { isAllowed: false }, admin);

    const { json } = await call('GET', '/api/admin/audit?limit=100', undefined, admin);
    const entries = json.entries as { action: string; actorUsername: string | null; actorId: number | null; details: Record<string, unknown>; targetId: string | null; ip: string | null; userAgent: string | null }[];
    const actions = entries.map((e) => e.action);

    // Newest first
    expect(actions.slice(0, 6)).toEqual([
      'domain.settings.update',
      'frontier.seed',
      'user.update',
      'user.create',
      'auth.login.success',
      'auth.login.failure',
    ]);
    expect(actions).toContain('system.admin.bootstrap');

    const failure = entries.find((e) => e.action === 'auth.login.failure')!;
    expect(failure.actorId).toBeNull();
    expect(failure.actorUsername).toBe('admin');
    expect(failure.userAgent).toBe('ops-test');

    const update = entries.find((e) => e.action === 'user.update')!;
    expect(update.details).toMatchObject({ username: 'auditee', passwordReset: true });
    expect(JSON.stringify(entries)).not.toContain('secret-pass-xyz'); // never the secret

    expect(entries.find((e) => e.action === 'frontier.seed')!.details).toMatchObject({ added: 1, submitted: 1 });
    expect(entries.find((e) => e.action === 'domain.settings.update')!.targetId).toBe('audit.example');
  });

  it('filters and keyset-paginates, and is admin-only', async () => {
    const users = await call('GET', '/api/admin/audit?action=user.', undefined, admin);
    expect((users.json.entries as { action: string }[]).every((e) => e.action.startsWith('user.'))).toBe(true);

    const byActor = await call('GET', '/api/admin/audit?actor=ADMIN', undefined, admin);
    expect((byActor.json.entries as { actorUsername: string }[]).every((e) => e.actorUsername === 'admin')).toBe(true);

    const page1 = await call('GET', '/api/admin/audit?limit=2', undefined, admin);
    const ids1 = (page1.json.entries as { id: number }[]).map((e) => e.id);
    const page2 = await call('GET', `/api/admin/audit?limit=2&before=${page1.json.nextBefore}`, undefined, admin);
    const ids2 = (page2.json.entries as { id: number }[]).map((e) => e.id);
    expect(ids1).toHaveLength(2);
    expect(Math.max(...ids2)).toBeLessThan(Math.min(...ids1));

    const viewer = await login('auditee', 'secret-pass-xyz');
    expect((await call('GET', '/api/admin/audit', undefined, viewer)).status).toBe(403);
    expect((await call('GET', '/api/admin/audit')).status).toBe(401);
  });

  it('is append-only, with retention as the only delete path', async () => {
    await expect(m.pool.query(`UPDATE audit_log SET action = 'tampered'`)).rejects.toThrow(/append-only/);

    await m.pool.query(
      `INSERT INTO audit_log (action, at) VALUES ('stats.reset', NOW() - INTERVAL '400 days')`
    );
    const before = Number((await m.pool.query('SELECT COUNT(*) FROM audit_log')).rows[0].count);
    expect(await m.audit.prune(365)).toBe(1);
    const after = Number((await m.pool.query('SELECT COUNT(*) FROM audit_log')).rows[0].count);
    expect(after).toBe(before - 1);
  });

  // -------------------------------------------------------------------------
  // Auth-state cache
  // -------------------------------------------------------------------------

  it('authorizes protected requests from Redis, without querying users', async () => {
    await call('GET', '/api/admin/ip-policy', undefined, admin); // warm
    const spy = vi.spyOn(m.pool, 'query');
    for (let i = 0; i < 10; i++) {
      expect((await call('GET', '/api/admin/ip-policy', undefined, admin)).status).toBe(200);
    }
    const userQueries = spy.mock.calls.filter(([sql]) => /FROM users/i.test(String(sql)));
    spy.mockRestore();
    expect(userQueries).toHaveLength(0);

    // A cache miss falls back to Postgres and re-populates
    const adminId = ((await me(admin)).user as { id: number }).id;
    await m.redis.del(m.REDIS_KEYS.AUTH_USER(adminId));
    expect((await call('GET', '/api/admin/ip-policy', undefined, admin)).status).toBe(200);
    expect(await m.redis.exists(m.REDIS_KEYS.AUTH_USER(adminId))).toBe(1);
  });

  it('keeps revocation immediate: a stale cache write can’t undo it', async () => {
    const { rows } = await m.pool.query(`SELECT id, session_version FROM users WHERE username = 'auditee'`);
    const { id, session_version: oldVersion } = rows[0];
    const viewer = await login('auditee', 'secret-pass-xyz');
    expect((await me(viewer)).authenticated).toBe(true);

    expect((await call('POST', `/api/admin/users/${id}/revoke-sessions`, undefined, admin)).status).toBe(200);
    expect((await me(viewer)).authenticated).toBe(false);

    // A slow reader that loaded the row before the revocation tries to cache it
    await m.users.cacheAuthState({ id, username: 'auditee', role: 'user', disabled: false, sessionVersion: oldVersion });
    const cached = JSON.parse((await m.redis.get(m.REDIS_KEYS.AUTH_USER(id)))!);
    expect(cached.v).toBeGreaterThan(oldVersion);

    // Deletion leaves a tombstone a stale reader can't overwrite either
    const again = await login('auditee', 'secret-pass-xyz');
    expect((await call('DELETE', `/api/admin/users/${id}`, undefined, admin)).status).toBe(204);
    // ...and their audit history is untouched (no FK cascade into audit_log)
    const history = await m.pool.query(`SELECT COUNT(*)::int AS n FROM audit_log WHERE actor_id = $1`, [id]);
    expect(history.rows[0].n).toBeGreaterThan(0);
    await m.users.cacheAuthState({ id, username: 'auditee', role: 'user', disabled: false, sessionVersion: oldVersion + 5 });
    expect(JSON.parse((await m.redis.get(m.REDIS_KEYS.AUTH_USER(id)))!).deleted).toBe(true);
    expect((await me(again)).authenticated).toBe(false);

    // Self-revocation goes through logout-others instead
    const adminId = ((await me(admin)).user as { id: number }).id;
    expect((await call('POST', `/api/admin/users/${adminId}/revoke-sessions`, undefined, admin)).status).toBe(400);
  });

  it('signs out other sessions but keeps the current one', async () => {
    const other = await login('admin', 'password123');
    const res = await call('POST', '/api/auth/logout-others', undefined, admin);
    expect(res.status).toBe(200);
    admin = (res.headers.get('set-cookie') ?? '').split(';')[0] || admin;
    expect((await me(admin)).authenticated).toBe(true);
    expect((await me(other)).authenticated).toBe(false);

    const { json } = await call('GET', '/api/admin/audit?action=auth.sessions', undefined, admin);
    expect((json.entries as { action: string }[])[0].action).toBe('auth.sessions.revoke_others');
  });

  // -------------------------------------------------------------------------
  // CDN exemptions from the per-IP lock
  // -------------------------------------------------------------------------

  it('exempts statically configured ranges from the per-IP lock', async () => {
    await m.frontier.addUrls(
      ['http://127.0.0.3:18131/a', 'http://127.0.0.3:18132/b', 'http://127.0.0.1:18133/c', 'http://127.0.0.1:18134/d'],
      { depth: 0, priority: 3 }
    );
    const claimed: string[] = [];
    for (let i = 0; i < 4; i++) {
      const next = await m.frontier.getNextUrl(`cdn-w${i}`);
      if (next) claimed.push(next.domain);
    }
    // Both exempt domains on 127.0.0.3 are claimable at once; only one of the
    // two non-exempt domains on 127.0.0.1 gets through the IP lock
    expect(claimed.filter((d) => d.startsWith('127.0.0.3'))).toHaveLength(2);
    expect(claimed.filter((d) => d.startsWith('127.0.0.1'))).toHaveLength(1);
    await m.frontier.clear();
  });

  it('loads exempt ranges from published lists and keeps the last good copy on failure', async () => {
    let res = await call('POST', '/api/admin/ip-policy/refresh', undefined, admin);
    expect(res.status).toBe(200);
    const sources = res.json.sources as { url: string; count: number; lastError: string | null }[];
    expect(sources.map((s) => s.count)).toEqual([2, 2, 1]);
    expect(sources.every((s) => s.lastError === null)).toBe(true);
    expect(res.json.effectiveCount).toBe(6); // 1 static + 5 from sources

    expect(await m.ipPolicy.isIpExempt('127.0.0.4')).toBe(true); // text list
    expect(await m.ipPolicy.isIpExempt('10.20.30.40')).toBe(true); // JSON list
    expect(await m.ipPolicy.isIpExempt('2001:db8:ffff::9')).toBe(true);
    expect(await m.ipPolicy.isIpExempt('192.0.2.10')).toBe(true); // flaky source, first fetch
    expect(await m.ipPolicy.isIpExempt('8.8.8.8')).toBe(false);

    // Second refresh: the flaky source now 500s; its previous list is kept
    res = await call('POST', '/api/admin/ip-policy/refresh', undefined, admin);
    const flaky = (res.json.sources as { url: string; count: number; lastError: string | null }[])[2];
    expect(flaky.count).toBe(1);
    expect(flaky.lastError).toMatch(/500/);
    expect(await m.ipPolicy.isIpExempt('192.0.2.10')).toBe(true);

    // Not due again for ipExemptRefreshHours
    expect(await m.ipPolicy.refreshSourcesIfDue()).toBe(false);

    const { json } = await call('GET', '/api/admin/audit?action=ip_policy', undefined, admin);
    expect((json.entries as unknown[]).length).toBe(2);
  });
});
