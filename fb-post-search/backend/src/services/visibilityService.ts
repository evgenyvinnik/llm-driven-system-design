/**
 * @fileoverview User visibility service for privacy-aware search.
 * Computes and caches visibility sets that determine which posts a user can see.
 * Central to the privacy model - ensures users only see posts they have permission to view.
 * Includes cache hit/miss metrics for monitoring.
 */

import { query } from '../config/database.js';
import { getCache, setCache, cacheKeys } from '../config/redis.js';
import { recordCacheAccess, logger } from '../shared/index.js';
import { RETENTION_THRESHOLDS } from '../shared/alertThresholds.js';

/**
 * Represents a user's visibility set - the fingerprints of posts they can access.
 */
interface VisibilitySet {
  fingerprints: string[];
  userId: string;
  friendIds: string[];
  updatedAt: string;
}

/**
 * Computes a user's visibility set for search filtering.
 * Determines which visibility fingerprints the user has access to based on:
 * - Public posts (everyone can see)
 * - Their own private posts
 * - Posts from their friends (friends-only visibility)
 * Results are cached in Redis for 15 minutes to reduce database load.
 * @param userId - The user's ID
 * @returns Promise resolving to the user's visibility set with fingerprints and friend IDs
 */
export async function getUserVisibilitySet(userId: string): Promise<VisibilitySet> {
  // Try cache first
  const cached = await getCache<VisibilitySet>(cacheKeys.userVisibility(userId));
  if (cached) {
    recordCacheAccess('visibility', true);
    logger.debug({ userId }, 'Visibility set cache hit');
    return cached;
  }

  recordCacheAccess('visibility', false);
  logger.debug({ userId }, 'Visibility set cache miss - computing');

  // Compute visibility set
  const fingerprints: string[] = [];

  // Everyone can see public posts
  fingerprints.push('PUBLIC');

  // Can see own private posts
  fingerprints.push(`PRIVATE:${userId}`);

  // Can see friends' posts (friends visibility)
  fingerprints.push(`FRIENDS:${userId}`);

  // Get all accepted friends
  interface FriendRow {
    friend_id: string;
  }

  const friends = await query<FriendRow>(
    `SELECT friend_id FROM friendships WHERE user_id = $1 AND status = 'accepted'`,
    [userId]
  );

  const friendIds = friends.map((f) => f.friend_id);

  // Can see friends' friends-only posts
  for (const friendId of friendIds) {
    fingerprints.push(`FRIENDS:${friendId}`);
  }

  const visibilitySet: VisibilitySet = {
    fingerprints,
    userId,
    friendIds,
    updatedAt: new Date().toISOString(),
  };

  // Cache for configured TTL (visibility can change when friendships change)
  await setCache(
    cacheKeys.userVisibility(userId),
    visibilitySet,
    RETENTION_THRESHOLDS.VISIBILITY_CACHE_TTL_SECONDS
  );

  return visibilitySet;
}

/**
 * Invalidates a user's cached visibility set.
 * Should be called when friendships change to ensure accurate search results.
 * @param userId - The user's ID whose cache should be invalidated
 * @returns Promise that resolves when cache is cleared
 */
export async function invalidateVisibilityCache(userId: string): Promise<void> {
  const { deleteCache } = await import('../config/redis.js');
  await deleteCache(cacheKeys.userVisibility(userId));
  logger.info({ userId }, 'Visibility cache invalidated');
}

/**
 * Retrieves the list of accepted friend IDs for a user.
 * @param userId - The user's ID
 * @returns Promise resolving to an array of friend user IDs
 */
export async function getUserFriendIds(userId: string): Promise<string[]> {
  interface FriendRow {
    friend_id: string;
  }

  const friends = await query<FriendRow>(
    `SELECT friend_id FROM friendships WHERE user_id = $1 AND status = 'accepted'`,
    [userId]
  );

  return friends.map((f) => f.friend_id);
}

/**
 * Checks if two users have an accepted friendship.
 * @param userId1 - First user's ID
 * @param userId2 - Second user's ID
 * @returns Promise resolving to true if users are friends, false otherwise
 */
export async function areUsersFriends(userId1: string, userId2: string): Promise<boolean> {
  interface CountRow {
    count: string;
  }

  const result = await query<CountRow>(
    `SELECT COUNT(*) as count FROM friendships
     WHERE user_id = $1 AND friend_id = $2 AND status = 'accepted'`,
    [userId1, userId2]
  );

  return parseInt(result[0].count, 10) > 0;
}
