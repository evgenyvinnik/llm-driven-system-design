/**
 * End-to-end crawl against real PostgreSQL + Redis and a local fixture site.
 *
 * Opt-in: `npm run test:integration` (sets INTEGRATION=1). Requires Postgres and
 * Redis on the configured hosts (docker-compose up -d). It FLUSHES the Redis DB
 * and TRUNCATES the crawler tables, so never point it at data you care about.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const enabled = process.env.INTEGRATION === '1';

// Config is read at import time, so set fast timings before loading modules
process.env.CRAWLER_RETRY_BASE_DELAY = '200';
process.env.CRAWLER_MAX_RETRIES = '2';
process.env.CRAWLER_MAX_DEPTH = '3';
process.env.CRAWLER_MAX_PAGES_PER_DOMAIN = '1000';

type Mods = {
  pool: typeof import('../models/database.js').pool;
  initDatabase: typeof import('../models/database.js').initDatabase;
  redis: typeof import('../models/redis.js').redis;
  REDIS_KEYS: typeof import('../models/redis.js').REDIS_KEYS;
  frontierService: typeof import('../services/frontier.js').frontierService;
  CrawlerService: typeof import('../services/crawler.js').CrawlerService;
};

const page = (body: string) => `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`;

function startSite(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void
): Promise<{ server: http.Server; origin: string; hits: { path: string; at: number }[] }> {
  const hits: { path: string; at: number }[] = [];
  const server = http.createServer((req, res) => {
    hits.push({ path: req.url || '', at: Date.now() });
    handler(req, res);
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, origin: `http://127.0.0.1:${port}`, hits });
    })
  );
}

describe.skipIf(!enabled)('crawler end-to-end', () => {
  let m: Mods;
  let siteA: Awaited<ReturnType<typeof startSite>>;
  let siteB: Awaited<ReturnType<typeof startSite>>;
  const counters: Record<string, number> = {};
  const bump = (k: string) => (counters[k] = (counters[k] ?? 0) + 1);

  beforeAll(async () => {
    const db = await import('../models/database.js');
    const r = await import('../models/redis.js');
    m = {
      pool: db.pool,
      initDatabase: db.initDatabase,
      redis: r.redis,
      REDIS_KEYS: r.REDIS_KEYS,
      frontierService: (await import('../services/frontier.js')).frontierService,
      CrawlerService: (await import('../services/crawler.js')).CrawlerService,
    };
    await m.initDatabase();
    await m.pool.query('TRUNCATE url_frontier, crawled_pages, domains RESTART IDENTITY');
    await m.redis.flushdb();

    siteA = await startSite((req, res) => {
      const html = (b: string) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(page(b));
      };
      switch (req.url) {
        case '/robots.txt':
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          return res.end('User-agent: *\nDisallow: /private\nCrawl-delay: 0.3\n');
        case '/':
          return html(`
            <a href="/a">a</a>
            <a href="/a?utm_source=newsletter">a alias</a>
            <a href="/private/secret">private</a>
            <a href="/redirect">redirect</a>
            <a href="/flaky">flaky</a>
            <a href="/throttle">throttle</a>
            <a href="/dup1">dup1</a>
            <a href="/dup2">dup2</a>
            <a href="/missing">missing</a>
            <a href="/ad" rel="nofollow">ad</a>
            <a href="/l1">deep</a>
          `);
        case '/a':
          return html('<a href="/">home</a><a href="/a">self</a>');
        case '/redirect':
          res.writeHead(301, { Location: '/target' });
          return res.end();
        case '/target':
          return html('target');
        case '/flaky':
          // First two requests (one crawl attempt incl. its in-process retry) fail
          if (bump('flaky') <= 2) {
            res.writeHead(503);
            return res.end();
          }
          return html('recovered');
        case '/throttle':
          if (bump('throttle') === 1) {
            res.writeHead(429, { 'Retry-After': '0' });
            return res.end();
          }
          return html('ok now');
        case '/dup1':
        case '/dup2':
          return html('identical body <a href="/from-dup">x</a>');
        case '/from-dup':
          return html('from dup');
        case '/l1':
          return html('<a href="/l2">l2</a>');
        case '/l2':
          return html('<a href="/l3">l3</a>');
        case '/l3':
          return html('<a href="/l4">l4 is beyond max depth</a>');
        default:
          res.writeHead(404);
          return res.end();
      }
    });

    // Site B: robots.txt keeps erroring -> URLs must be retried, never crawled
    siteB = await startSite((req, res) => {
      if (req.url === '/robots.txt') {
        res.writeHead(500);
        return res.end();
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(page('should never be fetched'));
    });
  });

  afterAll(async () => {
    if (!enabled) return;
    siteA?.server.close();
    siteB?.server.close();
    await m.pool.end();
    await m.redis.quit();
  });

  it('crawls the site with three workers: dedup, politeness, retries, redirects, robots', async () => {
    const added = await m.frontierService.addUrls(
      [`${siteA.origin}/`, `${siteA.origin}/`, `${siteB.origin}/page`],
      { priority: 3, depth: 0 }
    );
    expect(added).toBe(2);

    const workers = ['t1', 't2', 't3'].map((id) => new m.CrawlerService(id));
    const loops = workers.map((w) => w.start());

    // Wait until nothing is pending or in progress (or time out)
    const deadline = Date.now() + 45000;
    for (;;) {
      const { rows } = await m.pool.query(
        `SELECT COUNT(*)::int AS n FROM url_frontier WHERE status IN ('pending', 'in_progress')`
      );
      if (rows[0].n === 0 || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    await Promise.all(workers.map((w) => w.stop()));
    await Promise.all(loops);

    const { rows } = await m.pool.query(
      `SELECT url, status, retry_count, last_error FROM url_frontier ORDER BY url`
    );
    const byPath = new Map(
      rows.map((r) => [r.url.replace(siteA.origin, '').replace(siteB.origin, 'B:'), r])
    );
    const status = (p: string) => byPath.get(p)?.status;

    // Successful pages, incl. the redirect target and a page past a 503 and a 429
    for (const p of ['/', '/a', '/target', '/flaky', '/throttle', '/dup1', '/dup2', '/from-dup', '/l1', '/l2', '/l3']) {
      expect(status(p), p).toBe('completed');
    }
    expect(byPath.get('/flaky').retry_count).toBe(1);
    expect(byPath.get('/throttle').retry_count).toBe(1);

    // Redirect source is completed; its target was crawled as its own URL
    expect(status('/redirect')).toBe('completed');

    // Permanent failures are not retried
    expect(status('/private/secret')).toBe('failed');
    expect(byPath.get('/private/secret').last_error).toMatch(/robots/);
    expect(status('/missing')).toBe('failed');
    expect(byPath.get('/missing').retry_count).toBe(0);

    // Filtered: nofollow link, tracking-param alias, beyond max depth
    expect(byPath.has('/ad')).toBe(false);
    expect([...byPath.keys()].some((k) => k.includes('utm_'))).toBe(false);
    expect(byPath.has('/l4')).toBe(false);

    // Unreachable robots.txt: retried, then given up - and the page itself never fetched
    expect(status('B:/page')).toBe('failed');
    expect(byPath.get('B:/page').last_error).toMatch(/robots\.txt unavailable.*gave up/);
    expect(siteB.hits.some((h) => h.path === '/page')).toBe(false);

    // Exactly one copy of the duplicate content was detected
    expect(Number(await m.redis.get(m.REDIS_KEYS.STATS_DUPLICATE_CONTENT))).toBe(1);

    // No page was fetched twice by competing workers (except the intentional retries)
    const pageHits = siteA.hits.filter((h) => h.path !== '/robots.txt');
    const counts = new Map<string, number>();
    for (const h of pageHits) counts.set(h.path, (counts.get(h.path) ?? 0) + 1);
    for (const [path, n] of counts) {
      const expected = path === '/flaky' ? 3 : path === '/throttle' ? 2 : 1;
      expect(n, path).toBe(expected);
    }

    // Politeness: request starts to site A are >= crawl-delay apart, across all
    // three workers. (The in-process retry of /flaky waits >= 1s by itself.)
    const sorted = [...pageHits].sort((a, b) => a.at - b.at);
    const starts = sorted.map((h) => h.at);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1], JSON.stringify(sorted.slice(Math.max(0, i - 2), i + 1))).toBeGreaterThanOrEqual(280);
    }
  }, 60000);

  it('recovers expired leases back into the Redis queue', async () => {
    await m.frontierService.addUrls([`${siteA.origin}/lease-test`], { depth: 0, priority: 2 });
    await m.pool.query(
      `UPDATE url_frontier SET status = 'in_progress', updated_at = NOW() - INTERVAL '30 minutes'
       WHERE url LIKE '%/lease-test'`
    );
    await m.redis.zrem(m.REDIS_KEYS.PRIORITY_QUEUE_MEDIUM, ...(await m.redis.zrange(m.REDIS_KEYS.PRIORITY_QUEUE_MEDIUM, 0, -1)));

    expect(await m.frontierService.recoverStaleUrls(10)).toBe(1);
    expect(await m.redis.zcard(m.REDIS_KEYS.PRIORITY_QUEUE_MEDIUM)).toBe(1);
  });

  it('rehydrates Redis queues from Postgres after Redis data loss', async () => {
    await m.frontierService.addUrls(
      [`${siteA.origin}/r1`, `${siteA.origin}/r2`, `${siteA.origin}/r3`],
      { depth: 1, priority: 1 }
    );
    await m.redis.flushdb(); // simulate a Redis restart without persistence
    const rehydrated = await m.frontierService.rehydrateQueues();
    expect(rehydrated).toBeGreaterThanOrEqual(3);

    // Rehydrating again is a no-op
    expect(await m.frontierService.rehydrateQueues()).toBe(0);
  });
});
