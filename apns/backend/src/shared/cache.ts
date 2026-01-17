/**
 * Redis Caching Module.
 *
 * Provides cache-aside pattern implementation for device token lookups
 * and other frequently accessed data with configurable TTLs.
 *
 * WHY: Device token lookups are in the critical path for every notification.
 * Without caching, each notification would require a database query. With
 * cache-aside pattern:
 * - Hot tokens are served from Redis in < 1ms
 * - Database load is reduced by 80-90%
 * - Cache misses are automatically populated
 * - Stale data is prevented with explicit invalidation on writes
 *
 * Cache Strategy:
 * - Token lookups: Cache-aside with 1-hour TTL
 * - Negative lookups: Cache for 5 minutes to prevent repeated DB hits
 * - Connection state: Write-through (immediate consistency required)
 *
 * @module shared/cache
 */

import redis from "../db/redis.js";
import { logger } from "./logger.js";
import { cacheOperations, tokenLookupDuration } from "./metrics.js";
import { DeviceToken } from "../types/index.js";

/**
 * Cache TTL configuration in seconds.
 * Adjust based on data volatility and acceptable staleness.
 */
export const CACHE_TTL = {
  /** Device token data: 1 hour. Tokens rarely change. */
  TOKEN: 3600,
  /** Negative lookup (token not found): 5 minutes. */
  TOKEN_INVALID: 300,
  /** Device connection server: 5 minutes. Short TTL for reconnect handling. */
  CONNECTION: 300,
  /** Rate limit windows: 1 minute sliding window. */
  RATE_LIMIT: 60,
  /** Idempotency keys: 24 hours for replay protection. */
  IDEMPOTENCY: 86400,
} as const;

/**
 * Cache key prefixes for namespacing.
 */
export const CACHE_KEYS = {
  TOKEN: "cache:token:",
  TOKEN_INVALID: "cache:token:invalid:",
  CONNECTION: "cache:conn:",
  IDEMPOTENCY: "cache:idem:",
} as const;

/**
 * Gets a device token from cache.
 * Records cache hit/miss metrics.
 *
 * @param tokenHash - SHA-256 hash of the device token
 * @returns Cached device token or null if not in cache
 */
export async function getTokenFromCache(
  tokenHash: string
): Promise<DeviceToken | null> {
  const key = `${CACHE_KEYS.TOKEN}${tokenHash}`;
  const timer = tokenLookupDuration.startTimer({ cache_status: "hit" });

  try {
    const cached = await redis.get(key);

    if (cached) {
      cacheOperations.inc({ cache: "token", operation: "hit" });
      timer({ cache_status: "hit" });
      return JSON.parse(cached) as DeviceToken;
    }

    // Check if we have a cached negative result
    const invalidKey = `${CACHE_KEYS.TOKEN_INVALID}${tokenHash}`;
    const isInvalid = await redis.get(invalidKey);

    if (isInvalid) {
      // Token is known to be invalid/not found
      cacheOperations.inc({ cache: "token", operation: "hit" });
      timer({ cache_status: "hit" });
      return null;
    }

    cacheOperations.inc({ cache: "token", operation: "miss" });
    timer({ cache_status: "miss" });
    return null;
  } catch (error) {
    logger.error({
      event: "cache_error",
      operation: "get_token",
      error: (error as Error).message,
    });
    // On cache error, return null to fall through to database
    return null;
  }
}

/**
 * Stores a device token in cache.
 * Called after a successful database lookup.
 *
 * @param tokenHash - SHA-256 hash of the device token
 * @param device - Device token data to cache
 */
export async function setTokenInCache(
  tokenHash: string,
  device: DeviceToken
): Promise<void> {
  const key = `${CACHE_KEYS.TOKEN}${tokenHash}`;

  try {
    await redis.setex(key, CACHE_TTL.TOKEN, JSON.stringify(device));
    cacheOperations.inc({ cache: "token", operation: "set" });

    logger.debug({
      event: "cache_set",
      cache: "token",
      token_hash_prefix: tokenHash.substring(0, 8),
    });
  } catch (error) {
    logger.error({
      event: "cache_error",
      operation: "set_token",
      error: (error as Error).message,
    });
    // Cache write failures are non-fatal
  }
}

/**
 * Caches a negative lookup result (token not found or invalid).
 * Prevents repeated database queries for non-existent tokens.
 *
 * WHY: Bad actors or misconfigured apps may repeatedly send requests
 * with invalid tokens. Without negative caching, each request would
 * hit the database. Caching "not found" for 5 minutes provides protection.
 *
 * @param tokenHash - SHA-256 hash of the invalid token
 * @param reason - Reason for invalidity (for debugging)
 */
export async function setTokenInvalidInCache(
  tokenHash: string,
  reason: string = "not_found"
): Promise<void> {
  const key = `${CACHE_KEYS.TOKEN_INVALID}${tokenHash}`;

  try {
    await redis.setex(key, CACHE_TTL.TOKEN_INVALID, reason);
    cacheOperations.inc({ cache: "token", operation: "set" });

    logger.debug({
      event: "cache_set_invalid",
      cache: "token",
      token_hash_prefix: tokenHash.substring(0, 8),
      reason,
    });
  } catch (error) {
    logger.error({
      event: "cache_error",
      operation: "set_token_invalid",
      error: (error as Error).message,
    });
  }
}

/**
 * Invalidates a token in cache.
 * Called when a token is updated or invalidated in the database.
 *
 * WHY: When a token is invalidated (uninstall, token refresh, etc.),
 * we must remove it from cache immediately to prevent delivering
 * notifications to invalid tokens. This is the "explicit invalidation"
 * part of cache-aside.
 *
 * @param tokenHash - SHA-256 hash of the token to invalidate
 */
export async function invalidateTokenCache(tokenHash: string): Promise<void> {
  const key = `${CACHE_KEYS.TOKEN}${tokenHash}`;
  const invalidKey = `${CACHE_KEYS.TOKEN_INVALID}${tokenHash}`;

  try {
    await redis.del(key);
    // Also set the invalid marker so we don't re-query immediately
    await redis.setex(invalidKey, CACHE_TTL.TOKEN, "invalidated");
    cacheOperations.inc({ cache: "token", operation: "delete" });

    logger.debug({
      event: "cache_invalidate",
      cache: "token",
      token_hash_prefix: tokenHash.substring(0, 8),
    });
  } catch (error) {
    logger.error({
      event: "cache_error",
      operation: "invalidate_token",
      error: (error as Error).message,
    });
  }
}

/**
 * Checks if a notification ID has already been processed (idempotency check).
 * Returns true if this is a duplicate request.
 *
 * WHY: Providers may retry failed requests. Without idempotency, each retry
 * would create a new notification. By storing notification IDs for 24 hours,
 * we can detect and reject duplicates, ensuring exactly-once semantics from
 * the provider's perspective.
 *
 * @param notificationId - UUID of the notification
 * @returns true if this notification was already processed (duplicate)
 */
export async function checkIdempotency(
  notificationId: string
): Promise<boolean> {
  const key = `${CACHE_KEYS.IDEMPOTENCY}${notificationId}`;

  try {
    // SET NX returns null if key already exists
    const result = await redis.set(key, "1", "EX", CACHE_TTL.IDEMPOTENCY, "NX");
    const isDuplicate = result === null;

    if (isDuplicate) {
      logger.debug({
        event: "idempotency_duplicate",
        notification_id: notificationId,
      });
    }

    return isDuplicate;
  } catch (error) {
    logger.error({
      event: "cache_error",
      operation: "check_idempotency",
      error: (error as Error).message,
    });
    // On error, allow the request (fail open for availability)
    return false;
  }
}

/**
 * Marks a notification ID as processed.
 * Call this after successfully creating a notification.
 *
 * @param notificationId - UUID of the notification
 */
export async function markNotificationProcessed(
  notificationId: string
): Promise<void> {
  const key = `${CACHE_KEYS.IDEMPOTENCY}${notificationId}`;

  try {
    await redis.setex(key, CACHE_TTL.IDEMPOTENCY, "1");
  } catch (error) {
    logger.error({
      event: "cache_error",
      operation: "mark_notification_processed",
      error: (error as Error).message,
    });
  }
}

/**
 * Gets cached device connection server.
 *
 * @param deviceId - Device UUID
 * @returns Server ID if device is connected, null otherwise
 */
export async function getConnectionFromCache(
  deviceId: string
): Promise<string | null> {
  const key = `${CACHE_KEYS.CONNECTION}${deviceId}`;

  try {
    const cached = await redis.get(key);

    if (cached) {
      cacheOperations.inc({ cache: "connection", operation: "hit" });
      return cached;
    }

    cacheOperations.inc({ cache: "connection", operation: "miss" });
    return null;
  } catch (error) {
    logger.error({
      event: "cache_error",
      operation: "get_connection",
      error: (error as Error).message,
    });
    return null;
  }
}

/**
 * Sets device connection in cache (write-through).
 *
 * @param deviceId - Device UUID
 * @param serverId - Server ID handling the connection
 */
export async function setConnectionInCache(
  deviceId: string,
  serverId: string
): Promise<void> {
  const key = `${CACHE_KEYS.CONNECTION}${deviceId}`;

  try {
    await redis.setex(key, CACHE_TTL.CONNECTION, serverId);
    cacheOperations.inc({ cache: "connection", operation: "set" });
  } catch (error) {
    logger.error({
      event: "cache_error",
      operation: "set_connection",
      error: (error as Error).message,
    });
  }
}

/**
 * Removes device connection from cache.
 *
 * @param deviceId - Device UUID
 */
export async function removeConnectionFromCache(
  deviceId: string
): Promise<void> {
  const key = `${CACHE_KEYS.CONNECTION}${deviceId}`;

  try {
    await redis.del(key);
    cacheOperations.inc({ cache: "connection", operation: "delete" });
  } catch (error) {
    logger.error({
      event: "cache_error",
      operation: "remove_connection",
      error: (error as Error).message,
    });
  }
}

export default {
  getTokenFromCache,
  setTokenInCache,
  setTokenInvalidInCache,
  invalidateTokenCache,
  checkIdempotency,
  markNotificationProcessed,
  getConnectionFromCache,
  setConnectionInCache,
  removeConnectionFromCache,
  CACHE_TTL,
  CACHE_KEYS,
};
