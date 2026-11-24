/**
 * @fileoverview URL Frontier Service for the distributed web crawler.
 *
 * The URL frontier is the heart of any web crawler - it manages the queue of URLs
 * to be crawled with priority-based scheduling. This implementation uses a hybrid
 * approach with PostgreSQL for durability and Redis for fast access patterns.
 *
 * Data model:
 * - PostgreSQL `url_frontier` is the source of truth (status, retry_count, ...).
 * - Redis holds three sorted sets (high/medium/low). The member is the URL hash
 *   and the score is the **earliest time (ms) the URL may be crawled**. New URLs
 *   get `now`; retries get `now + backoff`. Dequeue reads only members whose
 *   score is <= now, so delayed retries need no separate timer queue.
 *
 * Invariants:
 * - A URL is claimed by exactly one worker: the pending -> in_progress transition
 *   is a conditional UPDATE (`WHERE status = 'pending'`), so two workers racing
 *   for the same hash cannot both win, even if politeness locks expire.
 * - Redis is a cache of Postgres: anything lost from Redis (restart, flush,
 *   lease recovery) is restored by `rehydrateQueues` / `recoverStaleUrls`.
 *
 * @module services/frontier
 */

import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { pool } from '../models/database.js';
import {
  redis,
  REDIS_KEYS,
  PRIORITY_QUEUES,
  queueKeyForPriority,
} from '../models/redis.js';
import {
  normalizeUrl,
  hashUrl,
  extractDomain,
  calculateDepth,
  calculatePriority,
  shouldCrawl,
  hostnameOf,
} from '../utils/url.js';
import { config } from '../config.js';
import { logger } from '../shared/logger.js';
import { isIpExempt } from './ipPolicy.js';

/**
 * Represents a URL entry in the frontier queue.
 */
export interface FrontierUrl {
  /** Unique database ID */
  id: number;
  /** The normalized URL string */
  url: string;
  /** SHA-256 hash of the normalized URL for fast lookup */
  urlHash: string;
  /** Domain hostname extracted from the URL */
  domain: string;
  /** Priority level: 3 (high), 2 (medium), 1 (low) */
  priority: number;
  /** Depth from seed URL (0 = seed, 1 = one hop, etc.) */
  depth: number;
  /** Current status: pending, in_progress, completed, failed */
  status: string;
  /** Number of transient failures so far */
  retryCount?: number;
  /** Last error message, if any */
  lastError?: string | null;
  /** When this URL was scheduled for crawling */
  scheduledAt: Date;
}

/**
 * Options for adding URLs to the frontier.
 */
export interface AddUrlOptions {
  /** Override the calculated priority (1-3) */
  priority?: number;
  /** Override the calculated depth */
  depth?: number;
  /** URL of the page where this link was found */
  parentUrl?: string;
}

/** How many queue heads to inspect per priority level on each dequeue. */
const DEQUEUE_SCAN_SIZE = 100;

/**
 * Compare-and-delete: only release the domain lock if this worker still owns it.
 * Prevents a worker from deleting a lock that expired and was re-acquired by
 * another worker.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

interface FrontierRow {
  id: number;
  url: string;
  url_hash: string;
  domain: string;
  priority: number;
  depth: number;
  status: string;
  retry_count: number | null;
  last_error: string | null;
  scheduled_at: Date;
}

function rowToFrontierUrl(row: FrontierRow): FrontierUrl {
  return {
    id: row.id,
    url: row.url,
    urlHash: row.url_hash,
    domain: row.domain,
    priority: row.priority,
    depth: row.depth,
    status: row.status,
    retryCount: row.retry_count ?? 0,
    lastError: row.last_error,
    scheduledAt: row.scheduled_at,
  };
}

/**
 * Computes the frontier-level retry delay for the n-th attempt (1-based),
 * using exponential backoff with +/-20% jitter so that a batch of URLs that
 * failed together (e.g. a domain outage) doesn't come back as a thundering herd.
 */
export function retryDelayMs(attempt: number, baseMs = config.crawler.retryBaseDelayMs): number {
  const exp = baseMs * Math.pow(2, Math.max(0, attempt - 1));
  const capped = Math.min(exp, 6 * 60 * 60 * 1000); // never more than 6h
  const jitter = 0.8 + Math.random() * 0.4;
  return Math.round(capped * jitter);
}

/**
 * URL Frontier Service - manages the queue of URLs to be crawled.
 */
export class FrontierService {
  /**
   * Adds a single URL to the frontier if not already visited or queued.
   *
   * @returns true if URL was newly added, false if skipped (duplicate or filtered)
   */
  async addUrl(url: string, options: AddUrlOptions = {}): Promise<boolean> {
    return (await this.addUrls([url], options)) > 0;
  }

  /**
   * Adds multiple URLs to the frontier in one batch.
   *
   * A page commonly yields hundreds of links, so this is written to cost a
   * constant number of round trips regardless of batch size:
   * 1. Normalize, filter (scheme, extension, length, max depth) and de-dup in memory
   * 2. One SMISMEMBER against the visited set
   * 3. One multi-row INSERT ... ON CONFLICT DO NOTHING RETURNING (Postgres dedup)
   * 4. One pipeline that ZADDs **only the rows that were actually inserted**
   *
   * Step 4 matters: re-adding a hash that is already queued would reset its
   * score to "now", pushing frequently-linked pages to the back of the queue
   * forever, and would inflate the links-discovered counter.
   *
   * @returns Number of URLs newly added (excluding duplicates and filtered URLs)
   */
  async addUrls(urls: string[], options: AddUrlOptions = {}): Promise<number> {
    if (urls.length === 0) return 0;

    // Depth check applies to the whole batch (all links from one page share a depth)
    if (options.depth !== undefined && options.depth > config.crawler.maxDepth) {
      return 0;
    }

    const candidates = new Map<
      string,
      { url: string; domain: string; priority: number; depth: number }
    >();

    for (const raw of urls) {
      if (typeof raw !== 'string') continue;
      const normalized = normalizeUrl(raw.trim());
      if (normalized.length > config.crawler.maxUrlLength) continue;
      if (!shouldCrawl(normalized)) continue;

      const domain = extractDomain(normalized);
      if (!domain) continue;

      const urlHash = hashUrl(normalized);
      if (candidates.has(urlHash)) continue;

      const depth = options.depth ?? calculateDepth(normalized);
      const isHomepage = depth === 0;
      const priority = clampPriority(
        options.priority ?? calculatePriority(normalized, depth, isHomepage)
      );
      candidates.set(urlHash, { url: normalized, domain, priority, depth });
    }

    if (candidates.size === 0) return 0;

    // Fast-path dedup against already-crawled URLs
    const hashes = [...candidates.keys()];
    const visitedFlags = await redis.smismember(REDIS_KEYS.VISITED_URLS, ...hashes);
    const unvisited = hashes.filter((_, i) => visitedFlags[i] !== 1);

    // Per-domain budget. Seeds (depth 0) are explicit operator intent and bypass it.
    const { allowed: fresh, skipped: overBudget } =
      options.depth === 0
        ? { allowed: unvisited, skipped: 0 }
        : await this.applyDomainBudget(unvisited, candidates);
    let duplicates = hashes.length - unvisited.length;

    let inserted: { url_hash: string; priority: number; domain: string }[] = [];
    if (fresh.length > 0) {
      const rows = fresh.map((h) => candidates.get(h)!);
      try {
        const result = await pool.query<{ url_hash: string; priority: number; domain: string }>(
          `INSERT INTO url_frontier (url, url_hash, domain, priority, depth, status, scheduled_at)
           SELECT u.url, u.url_hash, u.domain, u.priority, u.depth, 'pending', NOW()
           FROM unnest($1::text[], $2::text[], $3::text[], $4::int[], $5::int[])
             AS u(url, url_hash, domain, priority, depth)
           ON CONFLICT (url_hash) DO NOTHING
           RETURNING url_hash, priority, domain`,
          [
            rows.map((r) => r.url),
            fresh,
            rows.map((r) => r.domain),
            rows.map((r) => r.priority),
            rows.map((r) => r.depth),
          ]
        );
        inserted = result.rows;
      } catch (error) {
        logger.error({ err: error, count: fresh.length }, 'Error adding URLs to frontier');
        return 0;
      }
      duplicates += fresh.length - inserted.length;
    }

    const now = Date.now();
    const pipeline = redis.pipeline();
    for (const row of inserted) {
      // NX: never move an existing member (it may carry a retry delay)
      pipeline.zadd(queueKeyForPriority(row.priority), 'NX', now, row.url_hash);
    }
    if (inserted.length > 0) {
      pipeline.incrby(REDIS_KEYS.STATS_LINKS_DISCOVERED, inserted.length);
    }
    if (duplicates > 0) {
      pipeline.incrby(REDIS_KEYS.STATS_DUPLICATES_SKIPPED, duplicates);
    }
    if (overBudget > 0) {
      pipeline.incrby(REDIS_KEYS.STATS_BUDGET_SKIPPED, overBudget);
    }
    if (config.crawler.maxPagesPerDomain > 0) {
      const perDomain = new Map<string, number>();
      for (const row of inserted) {
        perDomain.set(row.domain, (perDomain.get(row.domain) ?? 0) + 1);
      }
      for (const [domain, n] of perDomain) {
        pipeline.hincrby(REDIS_KEYS.DOMAIN_ENQUEUED, domain, n);
      }
    }
    await pipeline.exec();

    return inserted.length;
  }

  /**
   * Enforces `maxPagesPerDomain`: drops URLs for domains whose frontier
   * already holds that many URLs.
   *
   * This bounds the damage of crawler traps that the depth limit doesn't catch
   * (a site generating infinite shallow URLs) and stops one large site from
   * crowding out breadth. Counts live in one Redis hash (`HMGET` per batch);
   * a domain missing from the hash is initialized from Postgres with HSETNX, so
   * a Redis restart doesn't reset budgets.
   *
   * The budget is soft: concurrent batches for one domain can overshoot by at
   * most one batch, which is acceptable for a trap defense.
   */
  private async applyDomainBudget(
    hashes: string[],
    candidates: Map<string, { domain: string }>
  ): Promise<{ allowed: string[]; skipped: number }> {
    const budget = config.crawler.maxPagesPerDomain;
    if (budget <= 0 || hashes.length === 0) return { allowed: hashes, skipped: 0 };

    const domains = [...new Set(hashes.map((h) => candidates.get(h)!.domain))];
    const counts = await redis.hmget(REDIS_KEYS.DOMAIN_ENQUEUED, ...domains);
    const used = new Map<string, number>();
    const missing: string[] = [];
    domains.forEach((d, i) => {
      if (counts[i] === null) missing.push(d);
      else used.set(d, parseInt(counts[i]!, 10) || 0);
    });

    if (missing.length > 0) {
      const result = await pool.query<{ domain: string; count: string }>(
        `SELECT domain, COUNT(*) AS count FROM url_frontier
         WHERE domain = ANY($1::text[]) GROUP BY domain`,
        [missing]
      );
      const fromDb = new Map(result.rows.map((r) => [r.domain, parseInt(r.count, 10)]));
      const pipeline = redis.pipeline();
      for (const d of missing) {
        const n = fromDb.get(d) ?? 0;
        used.set(d, n);
        pipeline.hsetnx(REDIS_KEYS.DOMAIN_ENQUEUED, d, n);
      }
      await pipeline.exec();
    }

    const allowed: string[] = [];
    for (const h of hashes) {
      const d = candidates.get(h)!.domain;
      const n = used.get(d) ?? 0;
      if (n < budget) {
        allowed.push(h);
        used.set(d, n + 1);
      }
    }
    return { allowed, skipped: hashes.length - allowed.length };
  }

  /**
   * Gets the next URL to crawl for a worker.
   *
   * 1. For each priority queue (high -> medium -> low), read up to 100 hashes
   *    whose eligible-at score is <= now.
   * 2. Load all of their rows in ONE query; drop hashes whose row is no longer
   *    pending (stale queue entries) from Redis in one ZREM.
   * 3. Walk candidates in queue order, skipping any domain we already found
   *    locked in this pass (so one hot domain doesn't cost 100 lock attempts).
   * 4. Acquire the per-domain politeness lock, then atomically claim the row
   *    with a conditional UPDATE. If another worker claimed it first, release
   *    our lock and keep looking.
   *
   * @returns The claimed URL, or null if nothing is eligible right now
   */
  async getNextUrl(workerId: string): Promise<FrontierUrl | null> {
    const now = Date.now();
    const lockedDomains = new Set<string>();
    const lockedIps = new Set<string>();

    for (const queueKey of PRIORITY_QUEUES) {
      const urlHashes = await redis.zrangebyscore(
        queueKey,
        '-inf',
        now,
        'LIMIT',
        0,
        DEQUEUE_SCAN_SIZE
      );
      if (urlHashes.length === 0) continue;

      const result = await pool.query<FrontierRow>(
        `SELECT id, url, url_hash, domain, priority, depth, status, retry_count, last_error, scheduled_at
         FROM url_frontier
         WHERE url_hash = ANY($1::text[]) AND status = 'pending'`,
        [urlHashes]
      );
      const rowsByHash = new Map(result.rows.map((r) => [r.url_hash, r]));

      const stale = urlHashes.filter((h) => !rowsByHash.has(h));
      if (stale.length > 0) {
        await redis.zrem(queueKey, ...stale);
      }

      for (const urlHash of urlHashes) {
        const row = rowsByHash.get(urlHash);
        if (!row || lockedDomains.has(row.domain)) continue;

        const slot = await this.acquirePolitenessSlot(row.domain, workerId, lockedIps);
        if (!slot.ok) {
          lockedDomains.add(row.domain);
          if (slot.lockedIp) lockedIps.add(slot.lockedIp);
          continue;
        }

        const claim = await pool.query<FrontierRow>(
          `UPDATE url_frontier
           SET status = 'in_progress', updated_at = NOW()
           WHERE id = $1 AND status = 'pending'
           RETURNING id, url, url_hash, domain, priority, depth, status, retry_count, last_error, scheduled_at`,
          [row.id]
        );
        await redis.zrem(queueKey, urlHash);

        if (claim.rowCount === 0) {
          // Another worker claimed it between our SELECT and UPDATE
          await this.releasePolitenessSlot(row.domain, slot.ip, workerId);
          continue;
        }

        return rowToFrontierUrl(claim.rows[0]);
      }
    }

    return null;
  }

  /**
   * Resolves the effective crawl delay (seconds) for a domain.
   *
   * Base = robots.txt Crawl-delay (stored by the robots service, which falls
   * back to the configured default). An operator override can only make the
   * crawler *slower*: effective = max(override, base). Letting an override go
   * below what the site asked for would turn a dashboard slider into a way to
   * violate robots.txt.
   */
  async getEffectiveDelaySeconds(domain: string): Promise<number> {
    const [[, override], [, robotsDelay]] = ((await redis
      .pipeline()
      .hget(REDIS_KEYS.DELAY_OVERRIDES, domain)
      .get(REDIS_KEYS.DOMAIN_DELAY(domain))
      .exec()) ?? [[null, null], [null, null]]) as [unknown, string | null][];
    const positive = (v: string | null) => {
      const n = parseFloat(v ?? '');
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const base = positive(robotsDelay) ?? config.crawler.defaultDelay / 1000;
    const operator = positive(override);
    return operator !== undefined ? Math.max(operator, base) : base;
  }

  /**
   * Acquires a distributed lock for a domain to enforce rate limiting.
   *
   * `SET key worker NX PX delay`: the lock self-expires after the crawl delay,
   * so lock acquisitions (and therefore request starts) for one domain are
   * spaced at least `delay` apart across the whole worker fleet, and a crashed
   * worker can never deadlock a domain. PX (milliseconds) honors fractional
   * delays such as `Crawl-delay: 0.5` that EX would round up.
   */
  async acquireDomainLock(domain: string, workerId: string): Promise<boolean> {
    const delaySeconds = await this.getEffectiveDelaySeconds(domain);
    const delayMs = Math.max(100, Math.round(delaySeconds * 1000));
    const result = await redis.set(REDIS_KEYS.DOMAIN_LOCK(domain), workerId, 'PX', delayMs, 'NX');
    return result === 'OK';
  }

  /**
   * Releases a domain lock early, only if this worker still holds it.
   */
  async releaseDomainLock(domain: string, workerId: string): Promise<void> {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, REDIS_KEYS.DOMAIN_LOCK(domain), workerId);
  }

  /**
   * Resolves the IP a domain's requests will go to, cached in Redis.
   *
   * Per-domain politeness alone lets a crawler hit one server with many
   * requests at once when many domains live on it (shared hosting, a
   * multi-tenant SaaS). Keying a second lock on the resolved IP closes that.
   * Lookups use the OS resolver (`dns.lookup`, honors /etc/hosts) and are
   * cached for `dnsCacheTtlSeconds`; failures are negatively cached for 60s.
   *
   * @returns The IP, or null if it can't be resolved (the fetch will then
   *          fail with ENOTFOUND and be retried, so no IP lock is needed)
   */
  async resolveDomainIp(domain: string): Promise<string | null> {
    const hostname = hostnameOf(domain);
    if (!hostname) return null;
    if (net.isIP(hostname)) return hostname;

    const key = REDIS_KEYS.DNS_CACHE(hostname);
    const cached = await redis.get(key);
    if (cached !== null) return cached || null;

    try {
      const { address } = await lookup(hostname);
      await redis.set(key, address, 'EX', config.crawler.dnsCacheTtlSeconds);
      return address;
    } catch {
      await redis.set(key, '', 'EX', 60);
      return null;
    }
  }

  /**
   * Acquires everything a worker needs before sending a request to `domain`:
   * the domain lock (spaced by crawl delay) and the IP lock (spaced by
   * `ipDelayMs`, shared by every domain on that server). If the IP lock is
   * taken, the domain lock is released so the domain's slot isn't burned.
   *
   * @param knownLockedIps - IPs already found locked in this scan (skipped
   *                         without touching Redis)
   */
  async acquirePolitenessSlot(
    domain: string,
    workerId: string,
    knownLockedIps?: Set<string>
  ): Promise<{ ok: boolean; ip: string | null; lockedIp?: string }> {
    const ipDelayMs = config.crawler.ipDelayMs;
    let ip = ipDelayMs > 0 ? await this.resolveDomainIp(domain) : null;
    // CDN ranges: unrelated sites share anycast IPs, so skip the IP lock
    // (per-domain politeness still applies)
    if (ip && (await isIpExempt(ip))) ip = null;
    if (ip && knownLockedIps?.has(ip)) return { ok: false, ip, lockedIp: ip };

    if (!(await this.acquireDomainLock(domain, workerId))) return { ok: false, ip };

    if (ip) {
      const got = await redis.set(REDIS_KEYS.IP_LOCK(ip), workerId, 'PX', ipDelayMs, 'NX');
      if (got !== 'OK') {
        await this.releaseDomainLock(domain, workerId);
        return { ok: false, ip, lockedIp: ip };
      }
    }
    return { ok: true, ip };
  }

  /**
   * Releases both politeness locks early (only if this worker still holds them).
   */
  async releasePolitenessSlot(domain: string, ip: string | null, workerId: string): Promise<void> {
    await this.releaseDomainLock(domain, workerId);
    if (ip) {
      await redis.eval(RELEASE_LOCK_SCRIPT, 1, REDIS_KEYS.IP_LOCK(ip), workerId);
    }
  }

  /**
   * Marks a URL as successfully completed and records it in the visited set.
   */
  async markCompleted(urlHash: string): Promise<void> {
    await pool.query(
      `UPDATE url_frontier SET status = 'completed', last_error = NULL, updated_at = NOW()
       WHERE url_hash = $1`,
      [urlHash]
    );
    await redis.sadd(REDIS_KEYS.VISITED_URLS, urlHash);
  }

  /**
   * Marks a URL as permanently failed (404, robots-disallowed, non-HTML,
   * retries exhausted). It is added to the visited set so it is never re-queued.
   */
  async markFailed(urlHash: string, error?: string): Promise<void> {
    await pool.query(
      `UPDATE url_frontier SET status = 'failed', last_error = $2, updated_at = NOW()
       WHERE url_hash = $1`,
      [urlHash, error?.substring(0, 1000) ?? null]
    );
    await redis.sadd(REDIS_KEYS.VISITED_URLS, urlHash);
  }

  /**
   * Handles a transient failure (timeout, connection reset, 5xx, 429).
   *
   * Increments retry_count; if it is still within `maxRetries`, the URL goes
   * back to pending with an exponentially growing eligible-at time. Otherwise
   * it is marked failed permanently.
   *
   * @param minDelayMs - Lower bound for the delay (e.g. from a Retry-After header)
   * @returns 'retry' if rescheduled, 'failed' if retries are exhausted
   */
  async scheduleRetry(
    urlHash: string,
    error: string,
    minDelayMs = 0
  ): Promise<'retry' | 'failed'> {
    const result = await pool.query<{ retry_count: number; priority: number }>(
      `UPDATE url_frontier
       SET retry_count = COALESCE(retry_count, 0) + 1, last_error = $2, updated_at = NOW()
       WHERE url_hash = $1
       RETURNING retry_count, priority`,
      [urlHash, error.substring(0, 1000)]
    );
    if (result.rowCount === 0) return 'failed';

    const { retry_count: attempts, priority } = result.rows[0];
    if (attempts > config.crawler.maxRetries) {
      await this.markFailed(urlHash, `${error} (gave up after ${attempts - 1} retries)`);
      return 'failed';
    }

    await this.deferUrl(urlHash, priority, Math.max(minDelayMs, retryDelayMs(attempts)));
    return 'retry';
  }

  /**
   * Returns a claimed URL to the queue without counting a failed attempt,
   * eligible again after `delayMs`. Used when the crawl never started (e.g.
   * the domain's circuit breaker is open).
   */
  async deferUrl(urlHash: string, priority: number, delayMs: number): Promise<void> {
    await pool.query(
      `UPDATE url_frontier
       SET status = 'pending',
           scheduled_at = NOW() + ($2::int * INTERVAL '1 millisecond'),
           updated_at = NOW()
       WHERE url_hash = $1`,
      [urlHash, Math.round(delayMs)]
    );
    await redis.zadd(queueKeyForPriority(priority), Date.now() + delayMs, urlHash);
  }

  /**
   * Gets aggregated statistics about the frontier.
   */
  async getStats(): Promise<{
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    totalDomains: number;
  }> {
    const result = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM url_frontier
      GROUP BY status
    `);

    const stats = { pending: 0, inProgress: 0, completed: 0, failed: 0 };
    for (const row of result.rows) {
      switch (row.status) {
        case 'pending':
          stats.pending = parseInt(row.count);
          break;
        case 'in_progress':
          stats.inProgress = parseInt(row.count);
          break;
        case 'completed':
          stats.completed = parseInt(row.count);
          break;
        case 'failed':
          stats.failed = parseInt(row.count);
          break;
      }
    }

    const domainResult = await pool.query(
      'SELECT COUNT(DISTINCT domain) as count FROM url_frontier'
    );
    const totalDomains = parseInt(domainResult.rows[0].count);

    return { ...stats, totalDomains };
  }

  /**
   * Returns the number of hashes in each Redis priority queue.
   */
  async getQueueDepths(): Promise<{ high: number; medium: number; low: number }> {
    const [high, medium, low] = await Promise.all(
      PRIORITY_QUEUES.map((key) => redis.zcard(key))
    );
    return { high, medium, low };
  }

  /**
   * Gets recently updated URLs from the frontier.
   */
  async getRecentUrls(limit: number = 50, status?: string): Promise<FrontierUrl[]> {
    let query = `
      SELECT id, url, url_hash, domain, priority, depth, status, retry_count, last_error, scheduled_at
      FROM url_frontier
    `;
    const params: (string | number)[] = [];

    if (status) {
      query += ' WHERE status = $1';
      params.push(status);
    }

    query += ' ORDER BY updated_at DESC LIMIT $' + (params.length + 1);
    params.push(limit);

    const result = await pool.query<FrontierRow>(query, params);
    return result.rows.map(rowToFrontierUrl);
  }

  /**
   * Recovers URLs whose lease expired (worker crashed mid-crawl).
   *
   * Resets `in_progress` rows older than the threshold back to `pending` **and
   * re-adds them to their Redis priority queue** - workers only dequeue from
   * Redis, so a row reset only in Postgres would never be crawled again.
   *
   * @returns Number of URLs recovered
   */
  async recoverStaleUrls(
    olderThanMinutes: number = config.crawler.staleLeaseMinutes
  ): Promise<number> {
    const result = await pool.query<{ url_hash: string; priority: number }>(
      `UPDATE url_frontier
       SET status = 'pending', updated_at = NOW()
       WHERE status = 'in_progress'
       AND updated_at < NOW() - INTERVAL '1 minute' * $1
       RETURNING url_hash, priority`,
      [olderThanMinutes]
    );

    if (result.rows.length > 0) {
      const now = Date.now();
      const pipeline = redis.pipeline();
      for (const row of result.rows) {
        pipeline.zadd(queueKeyForPriority(row.priority), 'NX', now, row.url_hash);
      }
      await pipeline.exec();
    }

    return result.rows.length;
  }

  /**
   * Re-populates the Redis priority queues from Postgres.
   *
   * Redis is a cache of the durable frontier. If Redis restarts without
   * persistence, is flushed, or a queue key is deleted, every pending URL
   * would be orphaned: present in Postgres but invisible to workers. This
   * compares the queued count with the pending count and, only if Redis is
   * missing entries, walks pending rows by keyset pagination and ZADDs them
   * with NX (existing members keep their retry delays).
   *
   * @returns Number of hashes re-added to Redis
   */
  async rehydrateQueues(batchSize = 1000): Promise<number> {
    const depths = await this.getQueueDepths();
    const queued = depths.high + depths.medium + depths.low;
    const pendingResult = await pool.query(
      `SELECT COUNT(*) AS count FROM url_frontier WHERE status = 'pending'`
    );
    const pending = parseInt(pendingResult.rows[0].count);
    if (queued >= pending) return 0;

    let lastId = 0;
    let added = 0;
    for (;;) {
      const result = await pool.query<{
        id: number;
        url_hash: string;
        priority: number;
        scheduled_at: Date;
      }>(
        `SELECT id, url_hash, priority, scheduled_at FROM url_frontier
         WHERE status = 'pending' AND id > $1
         ORDER BY id LIMIT $2`,
        [lastId, batchSize]
      );
      if (result.rows.length === 0) break;

      const now = Date.now();
      const pipeline = redis.pipeline();
      for (const row of result.rows) {
        const eligibleAt = Math.max(now, new Date(row.scheduled_at).getTime() || now);
        pipeline.zadd(queueKeyForPriority(row.priority), 'NX', eligibleAt, row.url_hash);
      }
      const replies = (await pipeline.exec()) ?? [];
      for (const [err, count] of replies) {
        if (!err) added += Number(count) || 0;
      }
      lastId = result.rows[result.rows.length - 1].id;
    }

    return added;
  }

  /**
   * Deletes every frontier row and empties the Redis priority queues.
   */
  async clear(): Promise<void> {
    await pool.query('DELETE FROM url_frontier');
    await redis.del(...PRIORITY_QUEUES, REDIS_KEYS.DOMAIN_ENQUEUED);
  }
}

function clampPriority(priority: number): number {
  const p = Math.round(Number(priority));
  if (!Number.isFinite(p)) return config.priorities.medium;
  return Math.min(config.priorities.high, Math.max(config.priorities.low, p));
}

/**
 * Singleton instance of the FrontierService.
 */
export const frontierService = new FrontierService();
