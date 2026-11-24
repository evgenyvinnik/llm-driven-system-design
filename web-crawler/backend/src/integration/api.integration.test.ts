/**
 * API-level integration tests against real PostgreSQL + Redis.
 *
 * Opt-in: `npm run test:integration` (sets INTEGRATION=1). Like the crawl test,
 * it FLUSHES the Redis DB and TRUNCATES the crawler tables.
 *
 * Covers: admin-only mutating routes, login/logout and its rate limit, domain
 * settings (max(override, robots) rule, durability across Redis loss), and the
 * per-domain page budget.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const enabled = process.env.INTEGRATION === '1';

// Config is read at import time
process.env.CRAWLER_MAX_PAGES_PER_DOMAIN = '5';

describe.skipIf(!enabled)('API end-to-end', () => {
  let server: Server;
  let base: string;
  let m: {
    pool: typeof import('../models/database.js').pool;
    redis: typeof import('../models/redis.js').redis;
    REDIS_KEYS: typeof import('../models/redis.js').REDIS_KEYS;
    frontierService: typeof import('../services/frontier.js').frontierService;
    republishAll: typeof import('../services/domainSettings.js').republishAll;
  };
  let cookie = '';

  const call = async (method: string, path: string, body?: unknown, withCookie = true) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(withCookie && cookie ? { Cookie: cookie } : {}),
      },
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

  beforeAll(async () => {
    const db = await import('../models/database.js');
    const r = await import('../models/redis.js');
    await db.initDatabase();
    await db.pool.query('TRUNCATE url_frontier, crawled_pages, domains RESTART IDENTITY');
    await r.redis.flushdb();

    const auth = await import('../middleware/auth.js');
    auth.initializeDefaultAdmin();
    const { app } = await import('../server.js');

    m = {
      pool: db.pool,
      redis: r.redis,
      REDIS_KEYS: r.REDIS_KEYS,
      frontierService: (await import('../services/frontier.js')).frontierService,
      republishAll: (await import('../services/domainSettings.js')).republishAll,
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

    const { status, json } = await call('GET', '/api/stats', undefined, false);
    expect(status).toBe(200);
    expect(typeof json.generatedAt).toBe('number');
    const hb = (json.workerHeartbeats as { workerId: string; ageMs: number }[]).find(
      (h) => h.workerId === 'w-test'
    )!;
    expect(hb.ageMs).toBeGreaterThanOrEqual(6500);
    expect(hb.ageMs).toBeLessThan(15000);

    expect((await call('GET', '/api/health', undefined, false)).status).toBe(200);
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
    ];
    for (const [method, path, body] of routes) {
      const { status } = await call(method, path, body, false);
      expect(status, `${method} ${path}`).toBe(401);
    }
    // Nothing was enqueued by the rejected calls
    const { rows } = await m.pool.query('SELECT COUNT(*)::int AS n FROM url_frontier');
    expect(rows[0].n).toBe(0);
  });

  it('logs in with the default dev credentials and rejects bad ones', async () => {
    expect((await call('POST', '/api/auth/login', { username: 'admin', password: 'admin' }, false)).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'nobody', password: 'x' }, false)).status).toBe(401);
    expect((await call('POST', '/api/auth/login', { username: 'admin' }, false)).status).toBe(400);

    const res = await call('POST', '/api/auth/login', { username: 'admin', password: 'password123' }, false);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toMatch(/crawler\.sid=/);
    expect(setCookie.toLowerCase()).toContain('httponly');
    cookie = setCookie.split(';')[0];

    const me = await call('GET', '/api/auth/me');
    expect(me.json.authenticated).toBe(true);
  });

  it('applies settings with max(override, robots) and survives Redis loss', async () => {
    // An override below robots.txt is stored but cannot speed the domain up
    let res = await call('PUT', '/api/domains/slow.example/settings', { crawlDelay: 0.5 });
    expect(res.status).toBe(200);
    expect(res.json.crawlDelayOverride).toBe(0.5);
    expect(res.json.effectiveCrawlDelay).toBe(2);

    await m.redis.set(m.REDIS_KEYS.DOMAIN_DELAY('slow.example'), '2');
    expect(await m.frontierService.getEffectiveDelaySeconds('slow.example')).toBe(2);

    // Slowing down works
    res = await call('PUT', '/api/domains/slow.example/settings', { crawlDelay: 5 });
    expect(res.json.effectiveCrawlDelay).toBe(5);
    expect(await m.frontierService.getEffectiveDelaySeconds('slow.example')).toBe(5);

    // Block, then lose Redis: the maintenance republish restores the block
    res = await call('PUT', '/api/domains/slow.example/settings', { isAllowed: false });
    expect(res.json.isAllowed).toBe(false);
    expect(await m.redis.exists(m.REDIS_KEYS.DOMAIN_BLOCKED('slow.example'))).toBe(1);

    await m.redis.del(
      m.REDIS_KEYS.DOMAIN_BLOCKED('slow.example'),
      m.REDIS_KEYS.DOMAIN_DELAY_OVERRIDE('slow.example')
    );
    expect(await m.republishAll()).toBe(1);
    expect(await m.redis.exists(m.REDIS_KEYS.DOMAIN_BLOCKED('slow.example'))).toBe(1);
    expect(await m.redis.get(m.REDIS_KEYS.DOMAIN_DELAY_OVERRIDE('slow.example'))).toBe('5');

    // Unblock + remove override clears the Redis keys
    res = await call('PUT', '/api/domains/slow.example/settings', { isAllowed: true, crawlDelay: null });
    expect(res.json.isAllowed).toBe(true);
    expect(res.json.crawlDelayOverride).toBeNull();
    expect(await m.redis.exists(m.REDIS_KEYS.DOMAIN_BLOCKED('slow.example'))).toBe(0);
    expect(await m.redis.exists(m.REDIS_KEYS.DOMAIN_DELAY_OVERRIDE('slow.example'))).toBe(0);

    // Validation
    expect((await call('PUT', '/api/domains/slow.example/settings', { crawlDelay: -1 })).status).toBe(400);
    expect((await call('PUT', '/api/domains/slow.example/settings', { isAllowed: 'no' })).status).toBe(400);
    expect((await call('PUT', '/api/domains/missing.example/settings', { isAllowed: false })).status).toBe(404);
  });

  it('enforces the per-domain page budget, exempting seeds, across Redis loss', async () => {
    const urls = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `https://budget.example/${prefix}${i}`);

    expect(await m.frontierService.addUrls(urls('a', 8), { depth: 1 })).toBe(5);
    expect(await m.frontierService.addUrls(urls('b', 3), { depth: 1 })).toBe(0);
    expect(Number(await m.redis.get(m.REDIS_KEYS.STATS_BUDGET_SKIPPED))).toBe(6);

    // Seeds are explicit operator intent
    expect(await m.frontierService.addUrls(['https://budget.example/seed'], { depth: 0 })).toBe(1);

    // Counter lost (Redis restart): recomputed from Postgres, still enforced
    await m.redis.hdel(m.REDIS_KEYS.DOMAIN_ENQUEUED, 'budget.example');
    expect(await m.frontierService.addUrls(urls('c', 2), { depth: 1 })).toBe(0);

    // Other domains are unaffected
    expect(await m.frontierService.addUrls(['https://other.example/x'], { depth: 1 })).toBe(1);

    // Clearing the frontier (as admin) resets budgets
    expect((await call('POST', '/api/frontier/seed', { urls: ['https://seeded.example/'] })).status).toBe(200);
    expect((await call('DELETE', '/api/frontier/clear')).status).toBe(200);
    expect(await m.frontierService.addUrls(urls('d', 2), { depth: 1 })).toBe(2);
  });

  it('logs out, after which mutations are rejected again', async () => {
    expect((await call('POST', '/api/auth/logout')).status).toBe(200);
    expect((await call('POST', '/api/stats/reset')).status).toBe(401);
    cookie = '';
  });

  it('rate-limits login attempts', async () => {
    await m.redis.del('crawler:ratelimit:login:127.0.0.1', 'crawler:ratelimit:login:::ffff:127.0.0.1');
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push(
        (await call('POST', '/api/auth/login', { username: 'admin', password: `wrong${i}` }, false)).status
      );
    }
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
