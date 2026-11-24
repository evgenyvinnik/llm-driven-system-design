/**
 * API-level integration tests against real PostgreSQL + Redis.
 *
 * Opt-in: `npm run test:integration` (sets INTEGRATION=1). Like the crawl test,
 * it FLUSHES the Redis DB and TRUNCATES the crawler tables (including users).
 *
 * Covers: admin-only mutating routes, login/logout and its rate limit, user
 * accounts (roles, session revocation, last-admin guard, password change,
 * break-glass bootstrap), domain settings (max(override, robots) rule,
 * two-way rebuild after Redis drift), per-IP politeness, and the per-domain
 * page budget.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const enabled = process.env.INTEGRATION === '1';

// Config is read at import time
process.env.CRAWLER_MAX_PAGES_PER_DOMAIN = '5';
process.env.CRAWLER_IP_DELAY_MS = '1000';

describe.skipIf(!enabled)('API end-to-end', () => {
  let server: Server;
  let base: string;
  let m: {
    pool: typeof import('../models/database.js').pool;
    redis: typeof import('../models/redis.js').redis;
    REDIS_KEYS: typeof import('../models/redis.js').REDIS_KEYS;
    frontierService: typeof import('../services/frontier.js').frontierService;
    settings: typeof import('../services/domainSettings.js');
    users: typeof import('../services/users.js');
  };
  /** Cookie of the bootstrap admin session */
  let admin = '';

  const call = async (method: string, path: string, body?: unknown, cookie = '') => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON body
    }
    return { status: res.status, json, headers: res.headers };
  };

  /** Login attempts are rate-limited per IP; tests log in often, so reset first. */
  const resetLoginLimit = () =>
    m.redis.del('crawler:ratelimit:login:127.0.0.1', 'crawler:ratelimit:login:::ffff:127.0.0.1');

  const login = async (username: string, password: string): Promise<string> => {
    await resetLoginLimit();
    const res = await call('POST', '/api/auth/login', { username, password });
    expect(res.status, `login ${username}`).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0];
  };

  const me = async (cookie: string) => (await call('GET', '/api/auth/me', undefined, cookie)).json;

  beforeAll(async () => {
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
      frontierService: (await import('../services/frontier.js')).frontierService,
      settings: await import('../services/domainSettings.js'),
      users,
    };

    await new Promise<void>((resolve) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // A domain row as if robots.txt asked for a 2s delay
    await m.pool.query(
      `INSERT INTO domains (domain, robots_txt, crawl_delay) VALUES ('slow.example', '', 2)`
    );
  });

  afterAll(async () => {
    if (!enabled) return;
    await new Promise((resolve) => server.close(resolve));
    await m.pool.end();
    await m.redis.quit();
  });

  it('serves reads publicly, including server-side heartbeat age', async () => {
    await m.redis.sadd(m.REDIS_KEYS.ACTIVE_WORKERS, 'w-test');
    await m.redis.set(m.REDIS_KEYS.WORKER_HEARTBEAT('w-test'), String(Date.now() - 7000));

    const { status, json } = await call('GET', '/api/stats');
    expect(status).toBe(200);
    expect(typeof json.generatedAt).toBe('number');
    const hb = (json.workerHeartbeats as { workerId: string; ageMs: number }[]).find(
      (h) => h.workerId === 'w-test'
    )!;
    expect(hb.ageMs).toBeGreaterThanOrEqual(6500);
    expect(hb.ageMs).toBeLessThan(15000);

    expect((await call('GET', '/api/health')).status).toBe(200);
  });

  it('rejects every mutating route without an admin session', async () => {
    const routes: [string, string, unknown?][] = [
      ['POST', '/api/frontier/add', { urls: ['https://a.example/'] }],
      ['POST', '/api/frontier/seed', { urls: ['https://a.example/'] }],
      ['POST', '/api/frontier/recover'],
      ['DELETE', '/api/frontier/clear'],
      ['POST', '/api/stats/reset'],
      ['PUT', '/api/domains/slow.example/settings', { isAllowed: false }],
      ['POST', '/api/domains/slow.example/refresh-robots'],
      ['DELETE', '/api/admin/frontier'],
      ['GET', '/api/admin/users'],
      ['POST', '/api/admin/users', { username: 'x', password: 'y', role: 'admin' }],
      ['POST', '/api/auth/password', { currentPassword: 'a', newPassword: 'b' }],
    ];
    for (const [method, path, body] of routes) {
      const { status } = await call(method, path, body);
      expect(status, `${method} ${path}`).toBe(401);
    }
    const { rows } = await m.pool.query('SELECT COUNT(*)::int AS n FROM url_frontier');
    expect(rows[0].n).toBe(0);
  });

  it('logs in the bootstrapped admin and rejects bad credentials', async () => {
    await resetLoginLimit();
    expect((await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'nobody', password: 'x' })).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'admin' })).status).toBe(400);

    await resetLoginLimit();
    const res = await call('POST', '/api/auth/login', { username: 'ADMIN', password: 'password123' });
    expect(res.status).toBe(200); // usernames are case-insensitive
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie.toLowerCase()).toContain('httponly');
    admin = setCookie.split(';')[0];

    const who = await me(admin);
    expect(who.authenticated).toBe(true);
    expect((who.user as { role: string }).role).toBe('admin');
  });

  it('manages users: roles are enforced and validated', async () => {
    let res = await call('POST', '/api/admin/users', { username: 'Viewer1', password: 'viewer-pass', role: 'user' }, admin);
    expect(res.status).toBe(201);
    expect(res.json.username).toBe('viewer1');
    expect(res.json).not.toHaveProperty('passwordHash');

    expect((await call('POST', '/api/admin/users', { username: 'viewer1', password: 'another-pass', role: 'user' }, admin)).status).toBe(409);
    expect((await call('POST', '/api/admin/users', { username: 'x', password: 'long-enough', role: 'user' }, admin)).status).toBe(400);
    expect((await call('POST', '/api/admin/users', { username: 'shortpw', password: 'short', role: 'user' }, admin)).status).toBe(400);
    expect((await call('POST', '/api/admin/users', { username: 'rooty', password: 'long-enough', role: 'root' }, admin)).status).toBe(400);

    // A read-only user can sign in but can't change anything
    const viewer = await login('viewer1', 'viewer-pass');
    expect((await call('POST', '/api/stats/reset', undefined, viewer)).status).toBe(403);
    expect((await call('GET', '/api/admin/users', undefined, viewer)).status).toBe(403);

    res = await call('GET', '/api/admin/users', undefined, admin);
    expect((res.json.users as { username: string }[]).map((u) => u.username)).toEqual(['admin', 'viewer1']);

    // Self-protection
    const adminId = ((await me(admin)).user as { id: number }).id;
    expect((await call('PATCH', `/api/admin/users/${adminId}`, { role: 'user' }, admin)).status).toBe(400);
    expect((await call('PATCH', `/api/admin/users/${adminId}`, { disabled: true }, admin)).status).toBe(400);
    expect((await call('DELETE', `/api/admin/users/${adminId}`, undefined, admin)).status).toBe(400);
    expect((await call('PATCH', '/api/admin/users/99999', { disabled: true }, admin)).status).toBe(404);
  });

  it('revokes sessions on disable, role change, and password reset', async () => {
    const { rows } = await m.pool.query(`SELECT id FROM users WHERE username = 'viewer1'`);
    const id = rows[0].id;

    let viewer = await login('viewer1', 'viewer-pass');
    expect((await me(viewer)).authenticated).toBe(true);

    // Disable: existing session dies immediately, and login is refused
    expect((await call('PATCH', `/api/admin/users/${id}`, { disabled: true }, admin)).status).toBe(200);
    expect((await me(viewer)).authenticated).toBe(false);
    await resetLoginLimit();
    expect((await call('POST', '/api/auth/login', { username: 'viewer1', password: 'viewer-pass' })).status).toBe(401);

    // Re-enable + promote: a session from before the promotion doesn't carry it
    expect((await call('PATCH', `/api/admin/users/${id}`, { disabled: false }, admin)).status).toBe(200);
    viewer = await login('viewer1', 'viewer-pass');
    expect((await call('PATCH', `/api/admin/users/${id}`, { role: 'admin' }, admin)).status).toBe(200);
    expect((await me(viewer)).authenticated).toBe(false);
    viewer = await login('viewer1', 'viewer-pass');
    expect(((await me(viewer)).user as { role: string }).role).toBe('admin');
    expect((await call('PATCH', `/api/admin/users/${id}`, { role: 'user' }, admin)).status).toBe(200);

    // Admin password reset kills the old session; the new password works
    viewer = await login('viewer1', 'viewer-pass');
    expect((await call('PATCH', `/api/admin/users/${id}`, { password: 'reset-by-admin' }, admin)).status).toBe(200);
    expect((await me(viewer)).authenticated).toBe(false);
    await login('viewer1', 'reset-by-admin');
  });

  it('lets a user change their own password, signing out their other sessions', async () => {
    const here = await login('viewer1', 'reset-by-admin');
    const elsewhere = await login('viewer1', 'reset-by-admin');

    await resetLoginLimit();
    expect((await call('POST', '/api/auth/password', { currentPassword: 'wrong-one', newPassword: 'brand-new-pw' }, here)).status).toBe(400);
    expect((await call('POST', '/api/auth/password', { currentPassword: 'reset-by-admin', newPassword: 'short' }, here)).status).toBe(400);
    const res = await call('POST', '/api/auth/password', { currentPassword: 'reset-by-admin', newPassword: 'brand-new-pw' }, here);
    expect(res.status).toBe(200);
    const reissued = (res.headers.get('set-cookie') ?? '').split(';')[0] || here;

    expect((await me(reissued)).authenticated).toBe(true); // this session survives
    expect((await me(elsewhere)).authenticated).toBe(false); // other sessions don't
    await resetLoginLimit();
    expect((await call('POST', '/api/auth/login', { username: 'viewer1', password: 'reset-by-admin' })).status).toBe(401);
    await login('viewer1', 'brand-new-pw');
  });

  it('never leaves zero active admins, even under concurrent demotions', async () => {
    const adminId = ((await me(admin)).user as { id: number }).id;

    // Service level: the only admin can't be demoted, disabled, or deleted
    await expect(m.users.updateUser(adminId, { role: 'user' })).rejects.toMatchObject({ status: 409 });
    await expect(m.users.updateUser(adminId, { disabled: true })).rejects.toMatchObject({ status: 409 });
    await expect(m.users.deleteUser(adminId)).rejects.toMatchObject({ status: 409 });

    // Two admins demote each other at the same time: exactly one wins
    const created = await call('POST', '/api/admin/users', { username: 'ops2', password: 'ops2-password', role: 'admin' }, admin);
    const ops2Id = created.json.id as number;
    const ops2 = await login('ops2', 'ops2-password');
    const [a, b] = await Promise.all([
      call('PATCH', `/api/admin/users/${ops2Id}`, { role: 'user' }, admin),
      call('PATCH', `/api/admin/users/${adminId}`, { role: 'user' }, ops2),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect([401, 403, 409]).toContain(statuses.find((s) => s !== 200));

    const { rows } = await m.pool.query(
      `SELECT COUNT(*)::int AS n FROM users WHERE role = 'admin' AND disabled = false`
    );
    expect(rows[0].n).toBe(1);

    // Restore: make sure `admin` is the remaining admin for later tests
    if (a.status !== 200) {
      await m.pool.query(`UPDATE users SET role = 'admin' WHERE id = $1`, [adminId]);
      await m.pool.query(`UPDATE users SET role = 'user' WHERE id = $1`, [ops2Id]);
    }
    admin = await login('admin', 'password123');
  });

  it('restores an admin from the environment if every admin is gone (break-glass)', async () => {
    await m.pool.query(`UPDATE users SET disabled = true, password_hash = 'x$1$a$b' WHERE username = 'admin'`);
    await m.users.ensureBootstrapAdmin();
    admin = await login('admin', 'password123');
    expect(((await me(admin)).user as { role: string }).role).toBe('admin');

    // With an active admin present, bootstrap is a no-op
    await m.users.ensureBootstrapAdmin();
    expect((await me(admin)).authenticated).toBe(true);
  });

  it('applies settings with max(override, robots); rebuild fixes drift both ways', async () => {
    let res = await call('PUT', '/api/domains/slow.example/settings', { crawlDelay: 0.5 }, admin);
    expect(res.status).toBe(200);
    expect(res.json.effectiveCrawlDelay).toBe(2); // override can't speed it up

    await m.redis.set(m.REDIS_KEYS.DOMAIN_DELAY('slow.example'), '2');
    expect(await m.frontierService.getEffectiveDelaySeconds('slow.example')).toBe(2);

    res = await call('PUT', '/api/domains/slow.example/settings', { crawlDelay: 5 }, admin);
    expect(res.json.effectiveCrawlDelay).toBe(5);
    expect(await m.frontierService.getEffectiveDelaySeconds('slow.example')).toBe(5);

    res = await call('PUT', '/api/domains/slow.example/settings', { isAllowed: false }, admin);
    expect(res.json.isAllowed).toBe(false);
    expect(await m.settings.isBlocked('slow.example')).toBe(true);

    // Drift 1: Redis lost the settings -> rebuild restores them
    await m.redis.del(m.REDIS_KEYS.BLOCKED_DOMAINS, m.REDIS_KEYS.DELAY_OVERRIDES);
    expect(await m.settings.republishAll()).toMatchObject({ applied: true, blocked: 1, overrides: 1 });
    expect(await m.settings.isBlocked('slow.example')).toBe(true);
    expect(await m.redis.hget(m.REDIS_KEYS.DELAY_OVERRIDES, 'slow.example')).toBe('5');

    // Unblock + remove override through the API
    res = await call('PUT', '/api/domains/slow.example/settings', { isAllowed: true, crawlDelay: null }, admin);
    expect(res.json.isAllowed).toBe(true);
    expect(await m.settings.isBlocked('slow.example')).toBe(false);

    // Drift 2: an un-block whose Redis write failed leaves stale entries -> rebuild removes them
    await m.redis.sadd(m.REDIS_KEYS.BLOCKED_DOMAINS, 'slow.example', 'ghost.example');
    await m.redis.hset(m.REDIS_KEYS.DELAY_OVERRIDES, 'slow.example', '9');
    expect(await m.settings.republishAll()).toMatchObject({ applied: true, blocked: 0, overrides: 0 });
    expect(await m.settings.isBlocked('slow.example')).toBe(false);
    expect(await m.settings.isBlocked('ghost.example')).toBe(false);
    expect(await m.redis.hget(m.REDIS_KEYS.DELAY_OVERRIDES, 'slow.example')).toBeNull();

    // Validation
    expect((await call('PUT', '/api/domains/slow.example/settings', { crawlDelay: -1 }, admin)).status).toBe(400);
    expect((await call('PUT', '/api/domains/slow.example/settings', { isAllowed: 'no' }, admin)).status).toBe(400);
    expect((await call('PUT', '/api/domains/missing.example/settings', { isAllowed: false }, admin)).status).toBe(404);
  });

  it('enforces per-IP politeness across domains on the same server', async () => {
    // Two "domains" (different ports) on one IP, both free of domain locks
    await m.frontierService.addUrls(['http://127.0.0.1:18101/a', 'http://127.0.0.1:18102/b'], {
      depth: 0,
      priority: 3,
    });
    expect(await m.frontierService.resolveDomainIp('127.0.0.1:18101')).toBe('127.0.0.1');
    expect(await m.frontierService.resolveDomainIp('localhost:18101')).toMatch(/^(127\.0\.0\.1|::1)$/);

    const first = await m.frontierService.getNextUrl('ip-w1');
    expect(first).not.toBeNull();
    // The other domain's lock is free, but the server's IP lock isn't
    expect(await m.frontierService.getNextUrl('ip-w2')).toBeNull();
    // ...and the failed attempt released that domain's lock instead of burning it
    const otherDomain = first!.domain === '127.0.0.1:18101' ? '127.0.0.1:18102' : '127.0.0.1:18101';
    expect(await m.redis.exists(m.REDIS_KEYS.DOMAIN_LOCK(otherDomain))).toBe(0);

    await new Promise((r) => setTimeout(r, 1100)); // CRAWLER_IP_DELAY_MS = 1000
    const second = await m.frontierService.getNextUrl('ip-w2');
    expect(second?.domain).toBe(otherDomain);

    await call('DELETE', '/api/frontier/clear', undefined, admin);
  });

  it('enforces the per-domain page budget, exempting seeds, across Redis loss', async () => {
    const urls = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `https://budget.example/${prefix}${i}`);

    expect(await m.frontierService.addUrls(urls('a', 8), { depth: 1 })).toBe(5);
    expect(await m.frontierService.addUrls(urls('b', 3), { depth: 1 })).toBe(0);
    expect(Number(await m.redis.get(m.REDIS_KEYS.STATS_BUDGET_SKIPPED))).toBe(6);

    expect(await m.frontierService.addUrls(['https://budget.example/seed'], { depth: 0 })).toBe(1);

    await m.redis.hdel(m.REDIS_KEYS.DOMAIN_ENQUEUED, 'budget.example');
    expect(await m.frontierService.addUrls(urls('c', 2), { depth: 1 })).toBe(0);

    expect(await m.frontierService.addUrls(['https://other.example/x'], { depth: 1 })).toBe(1);

    expect((await call('POST', '/api/frontier/seed', { urls: ['https://seeded.example/'] }, admin)).status).toBe(200);
    expect((await call('DELETE', '/api/frontier/clear', undefined, admin)).status).toBe(200);
    expect(await m.frontierService.addUrls(urls('d', 2), { depth: 1 })).toBe(2);
  });

  it('logs out, after which mutations are rejected again', async () => {
    expect((await call('POST', '/api/auth/logout', undefined, admin)).status).toBe(200);
    expect((await call('POST', '/api/stats/reset', undefined, admin)).status).toBe(401);
  });

  it('rate-limits login attempts', async () => {
    await resetLoginLimit();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await call('POST', '/api/auth/login', { username: 'admin', password: `wrong${i}` })).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
