/**
 * @fileoverview Operator domain settings: durable in PostgreSQL, published to Redis.
 *
 * Operators can block a domain or slow it down (crawl-delay override). Workers
 * read these on every claim, so they must be in Redis - but Redis alone is not
 * durable: a Redis restart without persistence would silently unblock every
 * blocked domain. So:
 *
 * - PostgreSQL `domains.is_allowed` / `domains.crawl_delay_override` are the truth
 * - `publish()` writes one domain's settings to Redis (after the Postgres write)
 * - `republishAll()` re-derives the Redis keys from Postgres; the maintenance
 *   loop runs it every interval, so a block or override lost from Redis (or
 *   whose publish failed) is restored within one interval. The reverse - an
 *   un-block whose Redis delete failed - is not swept (that would need a SCAN
 *   over every domain key); the API returns an error and re-submitting fixes it.
 *
 * `crawl_delay_override` is a separate column from `crawl_delay` (which holds
 * the robots.txt value and is rewritten on every robots refresh), so a refresh
 * can't erase an operator's choice.
 *
 * @module services/domainSettings
 */

import { pool } from '../models/database.js';
import { redis, REDIS_KEYS } from '../models/redis.js';

export interface DomainSettings {
  /** Operator crawl-delay override in seconds, or null for none */
  crawlDelayOverride: number | null;
  /** false = operator has blocked the domain */
  isAllowed: boolean;
}

/**
 * Publishes one domain's settings to the Redis keys workers read.
 */
export async function publish(domain: string, settings: DomainSettings): Promise<void> {
  const pipeline = redis.pipeline();
  if (settings.crawlDelayOverride !== null) {
    pipeline.set(REDIS_KEYS.DOMAIN_DELAY_OVERRIDE(domain), String(settings.crawlDelayOverride));
  } else {
    pipeline.del(REDIS_KEYS.DOMAIN_DELAY_OVERRIDE(domain));
  }
  if (settings.isAllowed) {
    pipeline.del(REDIS_KEYS.DOMAIN_BLOCKED(domain));
  } else {
    pipeline.set(REDIS_KEYS.DOMAIN_BLOCKED(domain), '1');
  }
  const results = (await pipeline.exec()) ?? [];
  const failed = results.find(([err]) => err);
  if (failed) throw failed[0];
}

/**
 * Re-publishes every non-default domain setting from PostgreSQL to Redis.
 *
 * Only domains with an override or a block are touched (a small set), so this
 * is cheap enough to run every maintenance interval.
 *
 * @returns Number of domains republished
 */
export async function republishAll(): Promise<number> {
  const result = await pool.query<{
    domain: string;
    crawl_delay_override: number | null;
    is_allowed: boolean | null;
  }>(
    `SELECT domain, crawl_delay_override, is_allowed
     FROM domains
     WHERE crawl_delay_override IS NOT NULL OR is_allowed = false`
  );

  if (result.rows.length === 0) return 0;

  const pipeline = redis.pipeline();
  for (const row of result.rows) {
    if (row.crawl_delay_override !== null) {
      pipeline.set(REDIS_KEYS.DOMAIN_DELAY_OVERRIDE(row.domain), String(row.crawl_delay_override));
    }
    if (row.is_allowed === false) {
      pipeline.set(REDIS_KEYS.DOMAIN_BLOCKED(row.domain), '1');
    }
  }
  await pipeline.exec();
  return result.rows.length;
}
