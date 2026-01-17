import redis from '../db/redis.js';
import { createComponentLogger } from './logger.js';
import { cacheOperations, redisOperationDuration } from './metrics.js';

/**
 * Redis cache layer for location data and device lookups.
 *
 * CACHE STRATEGY: Cache-Aside (Lazy Loading)
 * - On READ: Check cache first, if miss, fetch from DB and populate cache
 * - On WRITE: Invalidate cache (write-through would also work here)
 *
 * WHY CACHE-ASIDE FOR THIS SYSTEM:
 * - Location reads far exceed writes (users check locations more than reports come in)
 * - Stale data is acceptable for location history (< 15 min staleness matches key rotation)
 * - Simple invalidation on write prevents complex consistency issues
 *
 * TTL STRATEGY:
 * - Location cache: 15 minutes (matches key rotation period)
 * - Device list: 5 minutes (balance freshness vs. DB load)
 * - Latest location: 1 minute (users expect recent data)
 *
 * CACHE KEY NAMING CONVENTION:
 * - findmy:locations:{deviceId}:{period} - Location reports by period
 * - findmy:devices:{userId} - User's device list
 * - findmy:latest:{deviceId} - Latest location for quick access
 */

const log = createComponentLogger('cache');

// Cache TTL values in seconds
const CACHE_TTL = {
  LOCATION_REPORTS: 15 * 60, // 15 minutes (matches key rotation)
  DEVICE_LIST: 5 * 60, // 5 minutes
  LATEST_LOCATION: 60, // 1 minute
  DEVICE_BY_ID: 5 * 60, // 5 minutes
};

// Cache key prefixes
const CACHE_KEYS = {
  LOCATIONS: 'findmy:locations',
  DEVICES: 'findmy:devices',
  DEVICE: 'findmy:device',
  LATEST: 'findmy:latest',
  IDEMPOTENCY: 'findmy:idempotency',
};

/**
 * Cache service providing type-safe Redis operations with metrics.
 */
export class CacheService {
  /**
   * Get a value from cache.
   *
   * @param key - Cache key
   * @returns Parsed value or null if not found
   */
  async get<T>(key: string): Promise<T | null> {
    const timer = redisOperationDuration.startTimer({ operation: 'get' });
    try {
      const value = await redis.get(key);
      timer();

      if (value === null) {
        cacheOperations.inc({ operation: 'get', result: 'miss' });
        log.debug({ key }, 'Cache miss');
        return null;
      }

      cacheOperations.inc({ operation: 'get', result: 'hit' });
      log.debug({ key }, 'Cache hit');
      return JSON.parse(value) as T;
    } catch (error) {
      timer();
      log.error({ error, key }, 'Cache get error');
      cacheOperations.inc({ operation: 'get', result: 'error' });
      return null;
    }
  }

  /**
   * Set a value in cache with TTL.
   *
   * @param key - Cache key
   * @param value - Value to cache (will be JSON stringified)
   * @param ttlSeconds - Time to live in seconds
   */
  async set<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
    const timer = redisOperationDuration.startTimer({ operation: 'set' });
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
      timer();
      cacheOperations.inc({ operation: 'set', result: 'success' });
      log.debug({ key, ttl: ttlSeconds }, 'Cache set');
    } catch (error) {
      timer();
      log.error({ error, key }, 'Cache set error');
      cacheOperations.inc({ operation: 'set', result: 'error' });
    }
  }

  /**
   * Delete a key from cache (invalidation).
   *
   * @param key - Cache key to delete
   */
  async del(key: string): Promise<void> {
    const timer = redisOperationDuration.startTimer({ operation: 'del' });
    try {
      await redis.del(key);
      timer();
      cacheOperations.inc({ operation: 'del', result: 'success' });
      log.debug({ key }, 'Cache invalidated');
    } catch (error) {
      timer();
      log.error({ error, key }, 'Cache delete error');
    }
  }

  /**
   * Delete all keys matching a pattern.
   * Used for bulk invalidation (e.g., all locations for a device).
   *
   * @param pattern - Redis key pattern (e.g., "findmy:locations:device123:*")
   */
  async delPattern(pattern: string): Promise<void> {
    const timer = redisOperationDuration.startTimer({ operation: 'del_pattern' });
    try {
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
        log.debug({ pattern, count: keys.length }, 'Cache pattern invalidated');
      }
      timer();
    } catch (error) {
      timer();
      log.error({ error, pattern }, 'Cache pattern delete error');
    }
  }

  // ===== LOCATION-SPECIFIC CACHE METHODS =====

  /**
   * Get cached location reports for a device.
   *
   * @param deviceId - Device UUID
   * @returns Cached location data or null
   */
  async getLocations(deviceId: string): Promise<unknown[] | null> {
    const key = `${CACHE_KEYS.LOCATIONS}:${deviceId}`;
    return this.get<unknown[]>(key);
  }

  /**
   * Cache location reports for a device.
   *
   * @param deviceId - Device UUID
   * @param locations - Location reports to cache
   */
  async setLocations(deviceId: string, locations: unknown[]): Promise<void> {
    const key = `${CACHE_KEYS.LOCATIONS}:${deviceId}`;
    await this.set(key, locations, CACHE_TTL.LOCATION_REPORTS);
  }

  /**
   * Invalidate location cache for a device.
   * Called when a new location report is submitted.
   *
   * @param deviceId - Device UUID
   */
  async invalidateLocations(deviceId: string): Promise<void> {
    await this.delPattern(`${CACHE_KEYS.LOCATIONS}:${deviceId}*`);
    await this.del(`${CACHE_KEYS.LATEST}:${deviceId}`);
  }

  /**
   * Invalidate location cache by identifier hash.
   * Used when we receive a location report but don't know the device ID yet.
   *
   * @param identifierHash - The identifier hash from the report
   */
  async invalidateByIdentifierHash(identifierHash: string): Promise<void> {
    // We can't directly map identifier hash to device ID without a lookup,
    // so we use a secondary index or accept eventual consistency.
    // For now, we rely on TTL-based expiration.
    log.debug({ identifierHash }, 'Location report received, cache will expire via TTL');
  }

  // ===== DEVICE-SPECIFIC CACHE METHODS =====

  /**
   * Get cached device list for a user.
   *
   * @param userId - User ID
   * @returns Cached device list or null
   */
  async getDeviceList(userId: string): Promise<unknown[] | null> {
    const key = `${CACHE_KEYS.DEVICES}:${userId}`;
    return this.get<unknown[]>(key);
  }

  /**
   * Cache device list for a user.
   *
   * @param userId - User ID
   * @param devices - Device list to cache
   */
  async setDeviceList(userId: string, devices: unknown[]): Promise<void> {
    const key = `${CACHE_KEYS.DEVICES}:${userId}`;
    await this.set(key, devices, CACHE_TTL.DEVICE_LIST);
  }

  /**
   * Invalidate device list cache for a user.
   * Called when devices are added, updated, or deleted.
   *
   * @param userId - User ID
   */
  async invalidateDeviceList(userId: string): Promise<void> {
    await this.del(`${CACHE_KEYS.DEVICES}:${userId}`);
  }

  /**
   * Get a cached device by ID.
   *
   * @param deviceId - Device UUID
   * @returns Cached device or null
   */
  async getDevice(deviceId: string): Promise<unknown | null> {
    const key = `${CACHE_KEYS.DEVICE}:${deviceId}`;
    return this.get<unknown>(key);
  }

  /**
   * Cache a device by ID.
   *
   * @param deviceId - Device UUID
   * @param device - Device data to cache
   */
  async setDevice(deviceId: string, device: unknown): Promise<void> {
    const key = `${CACHE_KEYS.DEVICE}:${deviceId}`;
    await this.set(key, device, CACHE_TTL.DEVICE_BY_ID);
  }

  /**
   * Invalidate a cached device.
   *
   * @param deviceId - Device UUID
   */
  async invalidateDevice(deviceId: string): Promise<void> {
    await this.del(`${CACHE_KEYS.DEVICE}:${deviceId}`);
  }

  // ===== LATEST LOCATION CACHE =====

  /**
   * Get cached latest location for a device.
   *
   * @param deviceId - Device UUID
   * @returns Cached latest location or null
   */
  async getLatestLocation(deviceId: string): Promise<unknown | null> {
    const key = `${CACHE_KEYS.LATEST}:${deviceId}`;
    return this.get<unknown>(key);
  }

  /**
   * Cache latest location for a device.
   *
   * @param deviceId - Device UUID
   * @param location - Latest location to cache
   */
  async setLatestLocation(deviceId: string, location: unknown): Promise<void> {
    const key = `${CACHE_KEYS.LATEST}:${deviceId}`;
    await this.set(key, location, CACHE_TTL.LATEST_LOCATION);
  }
}

// Export singleton instance
export const cacheService = new CacheService();

export { CACHE_TTL, CACHE_KEYS };
export default cacheService;
