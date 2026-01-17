/**
 * Enhanced Redis caching module for FaceTime.
 *
 * Provides caching strategies for call state and user presence with:
 * - Cache-aside pattern for user profiles
 * - Write-through pattern for presence (real-time)
 * - TTL-based expiration with heartbeat refresh
 * - Metrics for cache hit/miss monitoring
 *
 * WHY presence caching enables fast call routing:
 * - Sub-millisecond lookup of online devices
 * - No database query during call setup hot path
 * - Automatic expiration handles disconnects
 * - Heartbeat refresh prevents stale data
 */

import { getRedisClient } from '../services/redis.js';
import { cacheHits, cacheMisses } from './metrics.js';
import { logger } from './logger.js';

// ============================================================================
// Cache Configuration
// ============================================================================

export const CACHE_TTL = {
  USER_PROFILE: 3600,      // 1 hour
  PRESENCE: 60,            // 60 seconds (refreshed by heartbeat)
  CALL_STATE: 7200,        // 2 hours
  IDEMPOTENCY: 300,        // 5 minutes
  TURN_CREDENTIALS: 270,   // 4.5 minutes (credentials valid for 5 min)
};

// ============================================================================
// User Profile Cache (Cache-Aside Pattern)
// ============================================================================

export interface CachedUserProfile {
  id: string;
  username: string;
  display_name: string;
  avatar_url: string | null;
  cachedAt: number;
}

/**
 * Gets a user profile from cache.
 * Implements cache-aside: check cache first, return null if not found.
 *
 * @param userId - The user ID to look up
 * @returns Cached user profile or null if not in cache
 */
export async function getCachedUserProfile(
  userId: string
): Promise<CachedUserProfile | null> {
  try {
    const client = await getRedisClient();
    const data = await client.get(`user:profile:${userId}`);

    if (data) {
      cacheHits.inc({ cache_type: 'user_profile' });
      return JSON.parse(data);
    }

    cacheMisses.inc({ cache_type: 'user_profile' });
    return null;
  } catch (error) {
    logger.error({ error, userId }, 'Error reading user profile from cache');
    cacheMisses.inc({ cache_type: 'user_profile' });
    return null;
  }
}

/**
 * Stores a user profile in cache.
 * Called after fetching from database.
 *
 * @param userId - The user ID
 * @param profile - The profile data to cache
 */
export async function setCachedUserProfile(
  userId: string,
  profile: Omit<CachedUserProfile, 'cachedAt'>
): Promise<void> {
  try {
    const client = await getRedisClient();
    const cacheData: CachedUserProfile = {
      ...profile,
      cachedAt: Date.now(),
    };
    await client.setEx(
      `user:profile:${userId}`,
      CACHE_TTL.USER_PROFILE,
      JSON.stringify(cacheData)
    );
  } catch (error) {
    logger.error({ error, userId }, 'Error writing user profile to cache');
  }
}

/**
 * Invalidates a user profile in cache.
 * Called when profile is updated.
 *
 * @param userId - The user ID to invalidate
 */
export async function invalidateUserProfile(userId: string): Promise<void> {
  try {
    const client = await getRedisClient();
    await client.del(`user:profile:${userId}`);
    logger.debug({ userId }, 'Invalidated user profile cache');
  } catch (error) {
    logger.error({ error, userId }, 'Error invalidating user profile cache');
  }
}

// ============================================================================
// Presence Cache (Write-Through Pattern)
// ============================================================================

export interface PresenceData {
  online: boolean;
  lastSeen: number;
  deviceType?: string;
}

/**
 * Gets all online devices for a user.
 * Used for call routing to determine available devices.
 *
 * @param userId - The user ID to look up
 * @returns Map of deviceId to presence data
 */
export async function getUserDevicePresence(
  userId: string
): Promise<Map<string, PresenceData>> {
  try {
    const client = await getRedisClient();
    const data = await client.hGetAll(`presence:${userId}`);

    const result = new Map<string, PresenceData>();
    for (const [deviceId, json] of Object.entries(data)) {
      try {
        result.set(deviceId, JSON.parse(json));
      } catch {
        // Invalid JSON, skip this entry
      }
    }

    if (result.size > 0) {
      cacheHits.inc({ cache_type: 'presence' });
    } else {
      cacheMisses.inc({ cache_type: 'presence' });
    }

    return result;
  } catch (error) {
    logger.error({ error, userId }, 'Error reading presence from cache');
    return new Map();
  }
}

/**
 * Updates a user's device presence.
 * Write-through: updates Redis immediately for real-time tracking.
 *
 * @param userId - The user ID
 * @param deviceId - The device ID
 * @param deviceType - Optional device type
 */
export async function updatePresence(
  userId: string,
  deviceId: string,
  deviceType?: string
): Promise<void> {
  try {
    const client = await getRedisClient();
    const presence: PresenceData = {
      online: true,
      lastSeen: Date.now(),
      deviceType,
    };

    await client
      .multi()
      .hSet(`presence:${userId}`, deviceId, JSON.stringify(presence))
      .expire(`presence:${userId}`, CACHE_TTL.PRESENCE)
      .exec();
  } catch (error) {
    logger.error({ error, userId, deviceId }, 'Error updating presence');
  }
}

/**
 * Refreshes presence TTL on heartbeat.
 * Keeps presence alive without updating lastSeen timestamp.
 *
 * @param userId - The user ID
 * @param deviceId - The device ID
 */
export async function refreshPresenceTTL(
  userId: string,
  deviceId: string
): Promise<void> {
  try {
    const client = await getRedisClient();
    await client.expire(`presence:${userId}`, CACHE_TTL.PRESENCE);
  } catch (error) {
    logger.error({ error, userId, deviceId }, 'Error refreshing presence TTL');
  }
}

/**
 * Removes a device from presence.
 * Called on disconnect.
 *
 * @param userId - The user ID
 * @param deviceId - The device ID
 */
export async function removePresence(
  userId: string,
  deviceId: string
): Promise<void> {
  try {
    const client = await getRedisClient();
    await client.hDel(`presence:${userId}`, deviceId);
    logger.debug({ userId, deviceId }, 'Removed device presence');
  } catch (error) {
    logger.error({ error, userId, deviceId }, 'Error removing presence');
  }
}

/**
 * Gets all online users with their devices.
 * Used for presence overview/debugging.
 *
 * @param userIds - Array of user IDs to check
 * @returns Map of userId to their online devices
 */
export async function getMultiUserPresence(
  userIds: string[]
): Promise<Map<string, Map<string, PresenceData>>> {
  try {
    const client = await getRedisClient();
    const pipeline = client.multi();

    for (const userId of userIds) {
      pipeline.hGetAll(`presence:${userId}`);
    }

    const results = await pipeline.exec();
    const presenceMap = new Map<string, Map<string, PresenceData>>();

    for (let i = 0; i < userIds.length; i++) {
      const userId = userIds[i];
      const data = results[i] as unknown as Record<string, string> | null;
      const devices = new Map<string, PresenceData>();

      if (data) {
        for (const [deviceId, json] of Object.entries(data)) {
          try {
            devices.set(deviceId, JSON.parse(json));
          } catch {
            // Invalid JSON, skip
          }
        }
      }

      if (devices.size > 0) {
        presenceMap.set(userId, devices);
      }
    }

    return presenceMap;
  } catch (error) {
    logger.error({ error }, 'Error reading multi-user presence');
    return new Map();
  }
}

// ============================================================================
// Call State Cache
// ============================================================================

export interface CachedCallState {
  id: string;
  initiatorId: string;
  initiatorDeviceId: string;
  calleeIds: string[];
  callType: 'video' | 'audio' | 'group';
  state: 'ringing' | 'connected' | 'ended';
  participants: Array<{ userId: string; deviceId: string }>;
  createdAt: number;
  answeredAt?: number;
}

/**
 * Gets call state from cache.
 *
 * @param callId - The call ID
 * @returns Cached call state or null
 */
export async function getCachedCallState(
  callId: string
): Promise<CachedCallState | null> {
  try {
    const client = await getRedisClient();
    const data = await client.get(`call:${callId}`);

    if (data) {
      cacheHits.inc({ cache_type: 'call_state' });
      return JSON.parse(data);
    }

    cacheMisses.inc({ cache_type: 'call_state' });
    return null;
  } catch (error) {
    logger.error({ error, callId }, 'Error reading call state from cache');
    return null;
  }
}

/**
 * Stores call state in cache.
 *
 * @param callId - The call ID
 * @param state - The call state to cache
 */
export async function setCachedCallState(
  callId: string,
  state: CachedCallState
): Promise<void> {
  try {
    const client = await getRedisClient();
    await client.setEx(
      `call:${callId}`,
      CACHE_TTL.CALL_STATE,
      JSON.stringify(state)
    );
  } catch (error) {
    logger.error({ error, callId }, 'Error writing call state to cache');
  }
}

/**
 * Deletes call state from cache.
 *
 * @param callId - The call ID
 */
export async function deleteCachedCallState(callId: string): Promise<void> {
  try {
    const client = await getRedisClient();
    await client.del(`call:${callId}`);
  } catch (error) {
    logger.error({ error, callId }, 'Error deleting call state from cache');
  }
}
