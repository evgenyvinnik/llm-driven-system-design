/**
 * Versioned cache for each user's first-degree connection list.
 *
 * Plain cache-aside has a race on this key: a reader that loaded the list just
 * before a connection was accepted can write that stale list back after the
 * writer deleted the key, and the stale list then survives for the whole TTL
 * (the profile keeps offering "Connect" to someone you are already connected to).
 *
 * Instead, every graph write bumps `graph:ver:{userId}` after its transaction
 * commits, and readers only read `connections:{userId}:v{version}`. A late refill
 * lands under a version nobody reads any more, so it cannot resurrect old data.
 * Redis errors degrade to a database read rather than failing the request.
 *
 * @module utils/graphCache
 */
import { redis } from './redis.js';
import { logger } from './logger.js';
import { cacheHitsTotal, cacheMissesTotal } from './metrics.js';

/** First-degree lists change rarely; the version bump handles freshness. */
const LIST_TTL_SECONDS = 3600;

const versionKey = (userId: number) => `graph:ver:${userId}`;
const listKey = (userId: number, version: string) => `connections:${userId}:v${version}`;

/** Spreads expiries by up to 10% so lists cached together don't expire together. */
function jitteredTtl(seconds: number): number {
  return Math.round(seconds * (0.9 + Math.random() * 0.2));
}

/**
 * Returns a user's first-degree connection ids, loading them on a miss.
 *
 * @param userId - The user whose connections are needed
 * @param load - Database loader used on a cache miss or when Redis is unavailable
 * @returns Connected user ids
 */
export async function getCachedFirstDegree(
  userId: number,
  load: () => Promise<number[]>
): Promise<number[]> {
  let version: string;
  try {
    version = (await redis.get(versionKey(userId))) ?? '0';
    const cached = await redis.get(listKey(userId, version));
    if (cached) {
      cacheHitsTotal.inc({ cache_name: 'connections' });
      return JSON.parse(cached) as number[];
    }
  } catch (error) {
    logger.warn({ error, userId }, 'Graph cache unavailable, reading connections from PostgreSQL');
    return load();
  }

  cacheMissesTotal.inc({ cache_name: 'connections' });
  const ids = await load();
  redis
    .set(listKey(userId, version), JSON.stringify(ids), 'EX', jitteredTtl(LIST_TTL_SECONDS))
    .catch((error: unknown) => logger.warn({ error, userId }, 'Failed to cache connections'));
  return ids;
}

/**
 * Invalidates the cached lists of every user touched by a graph write.
 * Must be called after the write's transaction commits.
 *
 * @param userIds - Users whose connection lists changed
 */
export async function bumpGraphVersion(userIds: number[]): Promise<void> {
  if (userIds.length === 0) return;
  try {
    const pipeline = redis.pipeline();
    for (const id of userIds) pipeline.incr(versionKey(id));
    await pipeline.exec();
  } catch (error) {
    // The list TTL still bounds staleness if Redis rejects the bump.
    logger.warn({ error, userIds }, 'Failed to bump graph cache version');
  }
}
