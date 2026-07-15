import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

/** Redis client instance for session storage and group-balance caching. */
export const redis = new Redis.default({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
});

// ============================================================================
// SESSION MANAGEMENT
// ============================================================================

const SESSION_PREFIX = 'session:';
const SESSION_TTL = 24 * 60 * 60; // 24 hours

/** Stores a user session in Redis with a 24-hour TTL. */
export const setSession = async (sessionId: string, userId: string): Promise<void> => {
  await redis.set(`${SESSION_PREFIX}${sessionId}`, userId, 'EX', SESSION_TTL);
};

/** Retrieves the user ID associated with a session, or null if expired/missing. */
export const getSession = async (sessionId: string): Promise<string | null> => {
  return await redis.get(`${SESSION_PREFIX}${sessionId}`);
};

/** Removes a session from Redis, effectively logging the user out. */
export const deleteSession = async (sessionId: string): Promise<void> => {
  await redis.del(`${SESSION_PREFIX}${sessionId}`);
};

// ============================================================================
// GROUP BALANCE CACHE
// ============================================================================
//
// Balances are a *derived* value (aggregation over every expense + settlement
// in a group). Recomputing on each read is wasteful for hot groups, so we cache
// the computed balance payload and invalidate on any write to that group.

const GROUP_BALANCE_PREFIX = 'group_balance:';
const GROUP_BALANCE_TTL = 300; // 5 minutes — safety net if an invalidation is missed

/** Returns the cached balance payload for a group, or null on cache miss. */
export const getCachedGroupBalance = async <T>(groupId: string): Promise<T | null> => {
  const cached = await redis.get(`${GROUP_BALANCE_PREFIX}${groupId}`);
  return cached ? (JSON.parse(cached) as T) : null;
};

/** Caches a group's computed balance payload with a short TTL. */
export const setCachedGroupBalance = async (groupId: string, payload: unknown): Promise<void> => {
  await redis.set(`${GROUP_BALANCE_PREFIX}${groupId}`, JSON.stringify(payload), 'EX', GROUP_BALANCE_TTL);
};

/** Evicts a group's cached balance after any expense or settlement mutation. */
export const invalidateGroupBalance = async (groupId: string): Promise<void> => {
  await redis.del(`${GROUP_BALANCE_PREFIX}${groupId}`);
};
