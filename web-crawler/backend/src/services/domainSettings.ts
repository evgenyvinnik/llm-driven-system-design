/**
 * @fileoverview Operator domain settings: durable in PostgreSQL, published to Redis.
 *
 * Operators can block a domain or slow it down (crawl-delay override). Workers
 * read these on every claim, so they must be in Redis - but Redis alone is not
 * durable: a Redis restart without persistence would silently unblock every
 * blocked domain. So:
 *
 * - PostgreSQL `domains.is_allowed` / `domains.crawl_delay_override` are the truth
 * - Redis holds two derived structures workers read:
 *   `crawler:blocked_domains` (SET) and `crawler:delay_overrides` (HASH)
 * - `publish()` applies one domain's change (after the Postgres write)
 * - `republishAll()` rebuilds both structures from Postgres, run by the
 *   maintenance loop every interval
 *
 * Why one SET and one HASH instead of a key per domain: a rebuild can then
 * replace them wholesale in one MULTI/EXEC, which fixes divergence in **both**
 * directions - a block lost from Redis comes back, and an un-block whose Redis
 * write failed (stale block left behind) is removed. With a key per domain,
 * finding stale keys would need a SCAN over every domain's keys.
 *
 * Race: a rebuild reads a Postgres snapshot, then writes Redis. If an operator
 * publishes a change in between, writing the older snapshot would revert it.
 * Every publish bumps `crawler:domain_settings:version`; the rebuild WATCHes
 * that key on a dedicated connection, so EXEC aborts if a publish happened
 * since the snapshot, and the next interval retries.
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
 * Publishes one domain's settings to the Redis structures workers read.
 * Applied atomically (MULTI/EXEC) together with the version bump.
 */
export async function publish(domain: string, settings: DomainSettings): Promise<void> {
  const tx = redis.multi();
  if (settings.crawlDelayOverride !== null) {
    tx.hset(REDIS_KEYS.DELAY_OVERRIDES, domain, String(settings.crawlDelayOverride));
  } else {
    tx.hdel(REDIS_KEYS.DELAY_OVERRIDES, domain);
  }
  if (settings.isAllowed) {
    tx.srem(REDIS_KEYS.BLOCKED_DOMAINS, domain);
  } else {
    tx.sadd(REDIS_KEYS.BLOCKED_DOMAINS, domain);
  }
  tx.incr(REDIS_KEYS.DOMAIN_SETTINGS_VERSION);
  const results = await tx.exec();
  const failed = results?.find(([err]) => err);
  if (!results || failed) throw failed?.[0] ?? new Error('Domain settings publish aborted');
}

/** Whether workers should skip this domain (operator block). */
export async function isBlocked(domain: string): Promise<boolean> {
  return (await redis.sismember(REDIS_KEYS.BLOCKED_DOMAINS, domain)) === 1;
}

export interface RepublishResult {
  /** false if a concurrent publish invalidated the snapshot (retried next interval) */
  applied: boolean;
  blocked: number;
  overrides: number;
}

/**
 * Rebuilds the blocked set and override hash from PostgreSQL.
 *
 * Only domains with a non-default setting are read (a small set), and the
 * rebuild replaces both Redis structures in one transaction, so stale entries
 * are removed as well as missing ones restored.
 */
export async function republishAll(): Promise<RepublishResult> {
  const conn = redis.duplicate();
  try {
    await conn.watch(REDIS_KEYS.DOMAIN_SETTINGS_VERSION);

    const result = await pool.query<{
      domain: string;
      crawl_delay_override: number | null;
      is_allowed: boolean | null;
    }>(
      `SELECT domain, crawl_delay_override, is_allowed
       FROM domains
       WHERE crawl_delay_override IS NOT NULL OR is_allowed = false`
    );

    const blocked = result.rows.filter((r) => r.is_allowed === false).map((r) => r.domain);
    const overrides = result.rows.filter((r) => r.crawl_delay_override !== null);

    const tx = conn.multi();
    tx.del(REDIS_KEYS.BLOCKED_DOMAINS, REDIS_KEYS.DELAY_OVERRIDES);
    if (blocked.length > 0) tx.sadd(REDIS_KEYS.BLOCKED_DOMAINS, ...blocked);
    for (const row of overrides) {
      tx.hset(REDIS_KEYS.DELAY_OVERRIDES, row.domain, String(row.crawl_delay_override));
    }
    const exec = await tx.exec(); // null => WATCHed version changed => aborted

    return { applied: exec !== null, blocked: blocked.length, overrides: overrides.length };
  } finally {
    conn.disconnect();
  }
}
