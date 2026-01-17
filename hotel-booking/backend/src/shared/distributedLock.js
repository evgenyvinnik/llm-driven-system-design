/**
 * Distributed Locking with Redis
 *
 * WHY distributed locking prevents room overselling:
 * - Pessimistic DB locks only work within a single database transaction
 * - Multiple API servers can process booking requests simultaneously
 * - Without distributed locks, two requests could both see "1 room available"
 *   and both create bookings, resulting in overselling
 *
 * Implementation uses Redis SETNX with:
 * - Unique lock IDs to prevent accidental unlock by other processes
 * - TTL to prevent deadlocks from crashed processes
 * - Retry with exponential backoff for contention
 */

const redis = require('../models/redis');
const { logger } = require('./logger');
const metrics = require('./metrics');
const crypto = require('crypto');

// Default lock configuration
const DEFAULT_LOCK_TTL_MS = 30000; // 30 seconds
const DEFAULT_RETRY_COUNT = 3;
const DEFAULT_RETRY_DELAY_MS = 100;
const DEFAULT_RETRY_JITTER_MS = 50;

/**
 * Acquire a distributed lock
 * @param {string} resource - Resource identifier (e.g., 'room:hotel123:type456')
 * @param {Object} options - Lock options
 * @returns {Object|null} Lock object with id and release function, or null if failed
 */
async function acquireLock(resource, options = {}) {
  const {
    ttlMs = DEFAULT_LOCK_TTL_MS,
    retryCount = DEFAULT_RETRY_COUNT,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    retryJitterMs = DEFAULT_RETRY_JITTER_MS,
  } = options;

  const lockKey = `lock:${resource}`;
  const lockId = crypto.randomUUID();
  const startTime = Date.now();

  for (let attempt = 0; attempt <= retryCount; attempt++) {
    try {
      // Try to acquire lock with SETNX semantics
      const result = await redis.set(lockKey, lockId, 'PX', ttlMs, 'NX');

      if (result === 'OK') {
        const waitTimeSeconds = (Date.now() - startTime) / 1000;

        metrics.distributedLockAcquisitionsTotal.inc({
          resource: normalizeResourceForMetrics(resource),
          success: 'true',
        });
        metrics.distributedLockWaitSeconds.observe(
          { resource: normalizeResourceForMetrics(resource) },
          waitTimeSeconds
        );

        logger.debug(
          { resource, lockId, attempt, waitTimeSeconds },
          'Distributed lock acquired'
        );

        return {
          id: lockId,
          resource,
          key: lockKey,
          release: () => releaseLock(lockKey, lockId),
        };
      }

      // Lock not acquired, wait and retry
      if (attempt < retryCount) {
        const jitter = Math.random() * retryJitterMs;
        const delay = retryDelayMs * Math.pow(2, attempt) + jitter;
        await sleep(delay);
      }
    } catch (error) {
      logger.error({ error, resource, attempt }, 'Error acquiring distributed lock');
    }
  }

  // Failed to acquire lock
  const waitTimeSeconds = (Date.now() - startTime) / 1000;

  metrics.distributedLockAcquisitionsTotal.inc({
    resource: normalizeResourceForMetrics(resource),
    success: 'false',
  });
  metrics.distributedLockWaitSeconds.observe(
    { resource: normalizeResourceForMetrics(resource) },
    waitTimeSeconds
  );

  logger.warn(
    { resource, retryCount, waitTimeSeconds },
    'Failed to acquire distributed lock'
  );

  return null;
}

/**
 * Release a distributed lock
 * Uses Lua script to ensure atomic check-and-delete
 * @param {string} lockKey - The lock key
 * @param {string} lockId - The lock ID to verify ownership
 * @returns {boolean} True if lock was released
 */
async function releaseLock(lockKey, lockId) {
  // Lua script for atomic check-and-delete
  // Only delete if the lock value matches our lockId
  const luaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;

  try {
    const result = await redis.eval(luaScript, 1, lockKey, lockId);

    if (result === 1) {
      logger.debug({ lockKey, lockId }, 'Distributed lock released');
      return true;
    } else {
      logger.warn({ lockKey, lockId }, 'Lock already released or stolen');
      return false;
    }
  } catch (error) {
    logger.error({ error, lockKey, lockId }, 'Error releasing distributed lock');
    return false;
  }
}

/**
 * Extend a lock's TTL
 * @param {string} lockKey - The lock key
 * @param {string} lockId - The lock ID to verify ownership
 * @param {number} ttlMs - New TTL in milliseconds
 * @returns {boolean} True if lock was extended
 */
async function extendLock(lockKey, lockId, ttlMs = DEFAULT_LOCK_TTL_MS) {
  const luaScript = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("pexpire", KEYS[1], ARGV[2])
    else
      return 0
    end
  `;

  try {
    const result = await redis.eval(luaScript, 1, lockKey, lockId, ttlMs);
    return result === 1;
  } catch (error) {
    logger.error({ error, lockKey, lockId }, 'Error extending distributed lock');
    return false;
  }
}

/**
 * Execute a function with a distributed lock
 * @param {string} resource - Resource to lock
 * @param {Function} fn - Function to execute while holding lock
 * @param {Object} options - Lock options
 * @returns {*} Result of the function
 * @throws {Error} If lock cannot be acquired
 */
async function withLock(resource, fn, options = {}) {
  const lock = await acquireLock(resource, options);

  if (!lock) {
    throw new Error(`Failed to acquire lock for resource: ${resource}`);
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

/**
 * Create a room booking lock resource identifier
 * @param {string} hotelId - Hotel ID
 * @param {string} roomTypeId - Room type ID
 * @param {string} checkIn - Check-in date
 * @param {string} checkOut - Check-out date
 * @returns {string} Lock resource identifier
 */
function createRoomLockResource(hotelId, roomTypeId, checkIn, checkOut) {
  return `room:${hotelId}:${roomTypeId}:${checkIn}:${checkOut}`;
}

/**
 * Normalize resource name for metrics to avoid high cardinality
 */
function normalizeResourceForMetrics(resource) {
  if (resource.startsWith('room:')) {
    return 'room_booking';
  }
  if (resource.startsWith('payment:')) {
    return 'payment';
  }
  return 'other';
}

/**
 * Sleep utility
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  acquireLock,
  releaseLock,
  extendLock,
  withLock,
  createRoomLockResource,
  DEFAULT_LOCK_TTL_MS,
};
