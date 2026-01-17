/**
 * @fileoverview Redis caching service with cache-aside pattern.
 * Provides cached access to frequently-read data like users, channels, and workspaces.
 * Implements cache-aside (lazy loading): read from cache first, populate on miss.
 *
 * WHY cache-aside pattern:
 * - Reduces database load for read-heavy workloads (user profiles, channel metadata)
 * - Only caches data that is actually accessed (memory efficient)
 * - Application controls cache population logic (flexibility)
 * - Handles cache failures gracefully (falls back to database)
 */

import { redis } from './redis.js';
import { query } from '../db/index.js';
import { logger } from './logger.js';
import { cacheCounter } from './metrics.js';
import type { User, Channel, Workspace } from '../types/index.js';

/** Cache TTL configuration in seconds */
const CACHE_TTL = {
  USER: 300,           // 5 minutes - user profiles change infrequently
  CHANNEL: 120,        // 2 minutes - channel metadata accessed often
  CHANNEL_MEMBERS: 120, // 2 minutes - member list for message delivery
  WORKSPACE: 600,      // 10 minutes - workspace settings rarely change
  SESSION: 86400,      // 24 hours - session tokens
};

/**
 * Cache key patterns for consistent naming.
 */
const CACHE_KEYS = {
  user: (userId: string) => `cache:user:${userId}`,
  channel: (channelId: string) => `cache:channel:${channelId}`,
  channelMembers: (channelId: string) => `cache:channel:${channelId}:members`,
  workspace: (workspaceId: string) => `cache:workspace:${workspaceId}`,
  workspaceMembers: (workspaceId: string) => `cache:workspace:${workspaceId}:members`,
};

// ============================================================================
// User Cache
// ============================================================================

/**
 * Gets a user by ID with cache-aside pattern.
 * First checks Redis cache, then falls back to PostgreSQL on cache miss.
 * @param userId - The user's unique identifier
 * @returns User object or null if not found
 */
export async function getCachedUser(userId: string): Promise<User | null> {
  const cacheKey = CACHE_KEYS.user(userId);

  try {
    // 1. Check cache first
    const cached = await redis.get(cacheKey);
    if (cached) {
      cacheCounter.inc({ cache_name: 'user', result: 'hit' });
      return JSON.parse(cached);
    }

    cacheCounter.inc({ cache_name: 'user', result: 'miss' });

    // 2. Cache miss - fetch from database
    const result = await query<User>(
      'SELECT id, email, username, display_name, avatar_url, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const user = result.rows[0];

    // 3. Populate cache for future reads
    await redis.setex(cacheKey, CACHE_TTL.USER, JSON.stringify(user));

    return user;
  } catch (error) {
    logger.error({ err: error, userId, msg: 'Error in getCachedUser' });
    // On cache error, fall back to database
    const result = await query<User>(
      'SELECT id, email, username, display_name, avatar_url, created_at, updated_at FROM users WHERE id = $1',
      [userId]
    );
    return result.rows[0] || null;
  }
}

/**
 * Invalidates a user's cache entry.
 * Call this when user data is updated (profile changes, avatar updates).
 * @param userId - The user's unique identifier
 */
export async function invalidateUserCache(userId: string): Promise<void> {
  try {
    await redis.del(CACHE_KEYS.user(userId));
    logger.debug({ userId, msg: 'User cache invalidated' });
  } catch (error) {
    logger.error({ err: error, userId, msg: 'Error invalidating user cache' });
  }
}

// ============================================================================
// Channel Cache
// ============================================================================

/**
 * Gets a channel by ID with cache-aside pattern.
 * @param channelId - The channel's unique identifier
 * @returns Channel object or null if not found
 */
export async function getCachedChannel(channelId: string): Promise<Channel | null> {
  const cacheKey = CACHE_KEYS.channel(channelId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      cacheCounter.inc({ cache_name: 'channel', result: 'hit' });
      return JSON.parse(cached);
    }

    cacheCounter.inc({ cache_name: 'channel', result: 'miss' });

    const result = await query<Channel>(
      'SELECT * FROM channels WHERE id = $1',
      [channelId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const channel = result.rows[0];
    await redis.setex(cacheKey, CACHE_TTL.CHANNEL, JSON.stringify(channel));

    return channel;
  } catch (error) {
    logger.error({ err: error, channelId, msg: 'Error in getCachedChannel' });
    const result = await query<Channel>('SELECT * FROM channels WHERE id = $1', [channelId]);
    return result.rows[0] || null;
  }
}

/**
 * Gets channel members with cache-aside pattern.
 * Critical for message delivery - called on every message send.
 * @param channelId - The channel's unique identifier
 * @returns Array of member user IDs
 */
export async function getCachedChannelMembers(channelId: string): Promise<string[]> {
  const cacheKey = CACHE_KEYS.channelMembers(channelId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      cacheCounter.inc({ cache_name: 'channel_members', result: 'hit' });
      return JSON.parse(cached);
    }

    cacheCounter.inc({ cache_name: 'channel_members', result: 'miss' });

    const result = await query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [channelId]
    );

    const memberIds = result.rows.map((row) => row.user_id);
    await redis.setex(cacheKey, CACHE_TTL.CHANNEL_MEMBERS, JSON.stringify(memberIds));

    return memberIds;
  } catch (error) {
    logger.error({ err: error, channelId, msg: 'Error in getCachedChannelMembers' });
    const result = await query<{ user_id: string }>(
      'SELECT user_id FROM channel_members WHERE channel_id = $1',
      [channelId]
    );
    return result.rows.map((row) => row.user_id);
  }
}

/**
 * Invalidates a channel's cache entries.
 * Call this when channel metadata or membership changes.
 * @param channelId - The channel's unique identifier
 */
export async function invalidateChannelCache(channelId: string): Promise<void> {
  try {
    await redis.del(CACHE_KEYS.channel(channelId));
    await redis.del(CACHE_KEYS.channelMembers(channelId));
    logger.debug({ channelId, msg: 'Channel cache invalidated' });
  } catch (error) {
    logger.error({ err: error, channelId, msg: 'Error invalidating channel cache' });
  }
}

// ============================================================================
// Workspace Cache
// ============================================================================

/**
 * Gets a workspace by ID with cache-aside pattern.
 * @param workspaceId - The workspace's unique identifier
 * @returns Workspace object or null if not found
 */
export async function getCachedWorkspace(workspaceId: string): Promise<Workspace | null> {
  const cacheKey = CACHE_KEYS.workspace(workspaceId);

  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      cacheCounter.inc({ cache_name: 'workspace', result: 'hit' });
      return JSON.parse(cached);
    }

    cacheCounter.inc({ cache_name: 'workspace', result: 'miss' });

    const result = await query<Workspace>(
      'SELECT * FROM workspaces WHERE id = $1',
      [workspaceId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const workspace = result.rows[0];
    await redis.setex(cacheKey, CACHE_TTL.WORKSPACE, JSON.stringify(workspace));

    return workspace;
  } catch (error) {
    logger.error({ err: error, workspaceId, msg: 'Error in getCachedWorkspace' });
    const result = await query<Workspace>('SELECT * FROM workspaces WHERE id = $1', [workspaceId]);
    return result.rows[0] || null;
  }
}

/**
 * Invalidates a workspace's cache entry.
 * Call this when workspace settings are updated.
 * @param workspaceId - The workspace's unique identifier
 */
export async function invalidateWorkspaceCache(workspaceId: string): Promise<void> {
  try {
    await redis.del(CACHE_KEYS.workspace(workspaceId));
    await redis.del(CACHE_KEYS.workspaceMembers(workspaceId));
    logger.debug({ workspaceId, msg: 'Workspace cache invalidated' });
  } catch (error) {
    logger.error({ err: error, workspaceId, msg: 'Error invalidating workspace cache' });
  }
}

// ============================================================================
// Batch Operations
// ============================================================================

/**
 * Gets multiple users by IDs with batched cache lookups.
 * Efficient for fetching reaction/reply user info.
 * @param userIds - Array of user IDs to fetch
 * @returns Map of userId to User object
 */
export async function getCachedUsers(userIds: string[]): Promise<Map<string, User>> {
  const result = new Map<string, User>();
  const cacheMisses: string[] = [];

  // Check cache for each user
  const cachePromises = userIds.map(async (userId) => {
    const cached = await redis.get(CACHE_KEYS.user(userId));
    if (cached) {
      cacheCounter.inc({ cache_name: 'user', result: 'hit' });
      result.set(userId, JSON.parse(cached));
    } else {
      cacheMisses.push(userId);
    }
  });

  await Promise.all(cachePromises);

  // Fetch cache misses from database
  if (cacheMisses.length > 0) {
    cacheMisses.forEach(() => cacheCounter.inc({ cache_name: 'user', result: 'miss' }));

    const dbResult = await query<User>(
      'SELECT id, email, username, display_name, avatar_url, created_at, updated_at FROM users WHERE id = ANY($1)',
      [cacheMisses]
    );

    // Populate cache and result map
    const cachePopulatePromises = dbResult.rows.map(async (user) => {
      result.set(user.id, user);
      await redis.setex(CACHE_KEYS.user(user.id), CACHE_TTL.USER, JSON.stringify(user));
    });

    await Promise.all(cachePopulatePromises);
  }

  return result;
}
