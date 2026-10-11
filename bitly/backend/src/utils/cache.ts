import Redis from 'ioredis';
import { REDIS_CONFIG, CACHE_CONFIG } from '../config.js';
import logger from './logger.js';
import { cacheHitsTotal, cacheMissesTotal } from './metrics.js';
import { boundedTtlSeconds } from './ttl.js';

/**
 * Redis client instance for caching operations.
 * Provides connection pooling and automatic retry on connection failures.
 * Used as a shared cache across all server instances.
 */
export const redis = new Redis({
  host: REDIS_CONFIG.host,
  port: REDIS_CONFIG.port,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
});

/**
 * Track Redis connection state for health checks.
 * hasEverConnected: Used to suppress initial connection errors during startup
 * isShuttingDown: Used to suppress errors during graceful shutdown
 */
let redisConnected = false;
let hasEverConnected = false;
let isShuttingDown = false;

redis.on('connect', () => {
  redisConnected = true;
  hasEverConnected = true;
  logger.info('Redis connected');
});

redis.on('ready', () => {
  redisConnected = true;
  hasEverConnected = true;
  logger.info('Redis ready');
});

redis.on('error', (error) => {
  redisConnected = false;
  // Only log errors after we've connected at least once (not during startup)
  // and not during shutdown
  if (hasEverConnected && !isShuttingDown) {
    logger.error({ err: error }, 'Redis connection error');
  }
});

redis.on('close', () => {
  redisConnected = false;
  if (!isShuttingDown) {
    logger.warn('Redis connection closed');
  }
});

/**
 * Returns the current Redis connection state.
 * Used by health check endpoints.
 */
export function isRedisConnected(): boolean {
  return redisConnected && redis.status === 'ready';
}

/** Positive entry: the redirect target plus its expiry. */
const urlKey = (shortCode: string): string => `url:${shortCode}`;
/** Negative entry: "this code does not resolve" (unknown, inactive, or expired). */
const negativeKey = (shortCode: string): string => `url:neg:${shortCode}`;
/** Short-lived marker written by every lifecycle write; blocks lookups from refilling. */
const guardKey = (shortCode: string): string => `url:inv:${shortCode}`;

/**
 * Cached redirect target. The expiry travels with the URL so a cache hit can enforce it
 * without a database round trip.
 */
export interface CachedUrl {
  url: string;
  /** Absolute expiry in epoch milliseconds, or null if the link never expires. */
  expiresAt: number | null;
}

/**
 * Serializes a cache entry into the JSON stored under `url:{code}`.
 * @param entry - The entry to store
 * @returns JSON string
 */
export function serializeCachedUrl(entry: CachedUrl): string {
  return JSON.stringify({ url: entry.url, expiresAt: entry.expiresAt });
}

/**
 * Parses a value read from `url:{code}`.
 * Anything that is not the current JSON shape returns null and is treated as a miss.
 * That includes legacy plain-string values written before expiry was cached: they carry
 * no expiry, so serving them could resurrect an expired link. The miss re-reads
 * PostgreSQL and rewrites the key in the new format.
 * @param raw - Raw Redis value
 * @returns Parsed entry or null
 */
export function parseCachedUrl(raw: string | null): CachedUrl | null {
  if (!raw || raw[0] !== '{') {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { url?: unknown; expiresAt?: unknown };
    if (typeof parsed.url !== 'string') {
      return null;
    }
    const { expiresAt } = parsed;
    if (expiresAt === null || expiresAt === undefined) {
      return { url: parsed.url, expiresAt: null };
    }
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      return null;
    }
    return { url: parsed.url, expiresAt };
  } catch {
    return null;
  }
}

/**
 * Whether a cached entry may still be served.
 * @param entry - Cached entry
 * @param nowMs - Current time in epoch milliseconds
 */
export function isCachedUrlLive(entry: CachedUrl, nowMs: number): boolean {
  return entry.expiresAt === null || entry.expiresAt > nowMs;
}

/**
 * TTL for a positive entry: the configured ceiling, but never past the link's expiry.
 * @param entry - Entry about to be cached
 * @param nowMs - Current time in epoch milliseconds
 * @returns Seconds to cache; 0 means the link is (nearly) expired and must not be cached
 */
export function urlCacheTtlSeconds(entry: CachedUrl, nowMs: number): number {
  return boundedTtlSeconds(entry.expiresAt, nowMs, CACHE_CONFIG.urlTTL);
}

/**
 * Lua: write KEYS[1] with a TTL unless the invalidation guard KEYS[2] exists.
 * Atomic, so a lookup that read PostgreSQL before a write cannot put the old row back
 * after the write deleted it (the classic cache-aside race).
 */
const FILL_UNLESS_INVALIDATED = `
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

/** Codes per MULTI when invalidating in bulk (cleanup jobs). */
const INVALIDATE_CHUNK_SIZE = 500;

/**
 * Cache operations for short code -> destination mappings.
 * Every method fails open: a Redis problem degrades the redirect path to PostgreSQL
 * reads instead of failing it.
 */
export const urlCache = {
  /**
   * Reads the positive and negative entries for a code in one round trip.
   * Skips Redis entirely while it is not ready, so an outage costs nothing per request
   * instead of waiting out the client's reconnect retries.
   * @param shortCode - Code to look up
   * @returns The cached entry (if any) and whether a negative entry exists
   */
  async lookup(shortCode: string): Promise<{ entry: CachedUrl | null; negative: boolean }> {
    if (!isRedisConnected()) {
      cacheMissesTotal.inc();
      return { entry: null, negative: false };
    }
    try {
      const [raw, negative] = await redis.mget(urlKey(shortCode), negativeKey(shortCode));
      const entry = parseCachedUrl(raw);
      const isNegative = entry === null && negative !== null;
      if (entry || isNegative) {
        cacheHitsTotal.inc();
        logger.debug({ short_code: shortCode, negative: isNegative }, 'Cache hit');
      } else {
        cacheMissesTotal.inc();
        logger.debug({ short_code: shortCode }, 'Cache miss');
      }
      return { entry, negative: isNegative };
    } catch (error) {
      logger.error({ err: error, short_code: shortCode }, 'Cache lookup failed');
      cacheMissesTotal.inc();
      return { entry: null, negative: false };
    }
  },

  /**
   * Back-fills a positive entry after a database read.
   * Never caches an expired link, and refuses to write while an invalidation guard exists.
   * @param shortCode - Code that was looked up
   * @param entry - Destination and expiry read from PostgreSQL
   */
  async fill(shortCode: string, entry: CachedUrl): Promise<void> {
    const ttl = urlCacheTtlSeconds(entry, Date.now());
    if (ttl <= 0 || !isRedisConnected()) {
      return;
    }
    try {
      await redis.eval(
        FILL_UNLESS_INVALIDATED,
        2,
        urlKey(shortCode),
        guardKey(shortCode),
        serializeCachedUrl(entry),
        ttl
      );
    } catch (error) {
      logger.error({ err: error, short_code: shortCode }, 'Cache fill failed');
    }
  },

  /**
   * Remembers that a code does not resolve, so enumeration traffic for unknown codes
   * stops reaching PostgreSQL. Short TTL; cleared by any write to the code.
   * @param shortCode - Code that did not resolve
   */
  async fillNegative(shortCode: string): Promise<void> {
    if (!isRedisConnected()) {
      return;
    }
    try {
      await redis.eval(
        FILL_UNLESS_INVALIDATED,
        2,
        negativeKey(shortCode),
        guardKey(shortCode),
        '1',
        CACHE_CONFIG.urlNegativeTTL
      );
    } catch (error) {
      logger.error({ err: error, short_code: shortCode }, 'Negative cache fill failed');
    }
  },

  /**
   * Authoritative write after a link is created: clears any negative entry, sets the
   * invalidation guard (so a lookup that started before the insert cannot write a stale
   * "not found"), and warms the positive entry unless the link is about to expire.
   * @param shortCode - Newly created code
   * @param entry - Destination and expiry of the new link
   */
  async prime(shortCode: string, entry: CachedUrl): Promise<void> {
    if (!isRedisConnected()) {
      return; // Lookups bypass Redis while it is down, so there is nothing to correct yet.
    }
    const ttl = urlCacheTtlSeconds(entry, Date.now());
    try {
      const tx = redis
        .multi()
        .set(guardKey(shortCode), '1', 'EX', CACHE_CONFIG.urlInvalidationGuardTTL)
        .del(negativeKey(shortCode));
      if (ttl > 0) {
        tx.set(urlKey(shortCode), serializeCachedUrl(entry), 'EX', ttl);
      }
      await tx.exec();
      logger.debug({ short_code: shortCode, ttl }, 'URL cached');
    } catch (error) {
      logger.error({ err: error, short_code: shortCode }, 'Cache prime failed');
    }
  },

  /**
   * Invalidates codes after a lifecycle write (owner update/delete, admin
   * deactivate/reactivate, expiry cleanup): deletes positive and negative entries and
   * sets the short invalidation guard.
   * Unlike reads, this is attempted even while Redis is reconnecting: the client queues it,
   * and a delayed invalidation is better than a stale entry living for the full TTL.
   * @param shortCodes - One code or many
   */
  async invalidate(shortCodes: string | string[]): Promise<void> {
    const codes = Array.isArray(shortCodes) ? shortCodes : [shortCodes];
    for (let i = 0; i < codes.length; i += INVALIDATE_CHUNK_SIZE) {
      const chunk = codes.slice(i, i + INVALIDATE_CHUNK_SIZE);
      try {
        const tx = redis.multi();
        for (const code of chunk) {
          tx.set(guardKey(code), '1', 'EX', CACHE_CONFIG.urlInvalidationGuardTTL);
          tx.del(urlKey(code), negativeKey(code));
        }
        await tx.exec();
        logger.debug({ count: chunk.length }, 'URL cache invalidated');
      } catch (error) {
        // The entry can now outlive the write by up to its TTL; make that visible.
        logger.error({ err: error, short_codes: chunk.slice(0, 10) }, 'Cache invalidation failed');
      }
    }
  },
};

/**
 * Session cache operations for user authentication.
 * Maps session tokens to user IDs. The TTL is always supplied by the caller and is bounded
 * by the session's remaining lifetime, so a cached session can never outlive its row.
 */
export const sessionCache = {
  /**
   * Reads a cached session. Throws immediately while Redis is not ready so the caller can
   * fall back to PostgreSQL without waiting out reconnect retries.
   * @param token - Session token
   * @returns The user ID, or null when not cached
   */
  async get(token: string): Promise<string | null> {
    if (!isRedisConnected()) {
      throw new Error('Redis not connected');
    }
    return redis.get(`session:${token}`);
  },

  /**
   * Caches a session for `ttlSeconds`. A non-positive TTL is a no-op.
   * @param token - Session token
   * @param userId - Owner of the session
   * @param ttlSeconds - Seconds until the session expires (already bounded by the caller)
   */
  async set(token: string, userId: string, ttlSeconds: number): Promise<void> {
    if (ttlSeconds <= 0) {
      return;
    }
    if (!isRedisConnected()) {
      throw new Error('Redis not connected');
    }
    await redis.setex(`session:${token}`, ttlSeconds, userId);
  },

  /**
   * Removes a cached session. Not short-circuited while Redis reconnects: logout needs
   * this to actually happen (or fail loudly).
   * @param token - Session token
   */
  async delete(token: string): Promise<void> {
    await redis.del(`session:${token}`);
  },
};

/**
 * Closes the Redis connection during graceful shutdown.
 * Sets the shutdown flag to suppress connection error logs.
 * @returns Promise that resolves when the connection is closed
 */
export async function closeRedis(): Promise<void> {
  isShuttingDown = true;
  await redis.quit();
  logger.info('Redis connection closed');
}
