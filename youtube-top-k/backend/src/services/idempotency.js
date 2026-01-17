/**
 * Idempotency service for preventing duplicate view event processing
 *
 * Uses Redis to track processed idempotency keys with configurable TTL.
 * This prevents the same view event from being counted multiple times
 * due to network retries, duplicate requests, or client-side issues.
 *
 * WHY IDEMPOTENCY MATTERS:
 * 1. Network retries: Clients may retry requests on timeout, causing duplicate views
 * 2. Double-clicks: Users may accidentally trigger multiple view events
 * 3. Client bugs: Frontend code may fire events multiple times
 * 4. Load balancer retries: Some LBs retry on backend failures
 *
 * Without idempotency, a video's view count could be artificially inflated,
 * leading to incorrect trending rankings.
 */

import { getRedisClient } from '../services/redis.js';
import { IDEMPOTENCY_CONFIG } from '../shared/config.js';
import { logIdempotencyCheck } from '../shared/logger.js';
import { duplicateViewEvents } from '../shared/metrics.js';

/**
 * Generate an idempotency key for a view event
 * @param {string} videoId - The video ID being viewed
 * @param {string} sessionId - The session or user ID
 * @param {string} [requestId] - Optional request ID from headers
 * @returns {string} Idempotency key
 */
export function generateIdempotencyKey(videoId, sessionId, requestId) {
  // If a request ID is provided (e.g., from X-Request-Id header), use it
  if (requestId) {
    return `${IDEMPOTENCY_CONFIG.keyPrefix}${requestId}`;
  }

  // Otherwise, generate a key based on video + session + timestamp bucket
  // Use 10-second buckets to allow some time tolerance for duplicates
  const timeBucket = Math.floor(Date.now() / 10000);
  return `${IDEMPOTENCY_CONFIG.keyPrefix}${videoId}:${sessionId || 'anon'}:${timeBucket}`;
}

/**
 * Check if a view event is a duplicate and mark it as processed
 *
 * Uses Redis SETNX (SET if Not eXists) for atomic check-and-set.
 * This is a common pattern for distributed idempotency.
 *
 * @param {string} idempotencyKey - The idempotency key to check
 * @returns {Promise<{isDuplicate: boolean, key: string}>}
 */
export async function checkAndMarkProcessed(idempotencyKey) {
  const client = await getRedisClient();

  // Use SET with NX (only set if not exists) and EX (expiration)
  // Returns 'OK' if the key was set, null if it already existed
  const result = await client.set(idempotencyKey, '1', {
    NX: true, // Only set if not exists
    EX: IDEMPOTENCY_CONFIG.keyTtlSeconds, // Expire after TTL
  });

  const isDuplicate = result === null;

  logIdempotencyCheck(idempotencyKey, isDuplicate);

  return {
    isDuplicate,
    key: idempotencyKey,
  };
}

/**
 * Check if a view event is a duplicate (without marking)
 *
 * Useful for read-only checks or reporting.
 *
 * @param {string} idempotencyKey - The idempotency key to check
 * @returns {Promise<boolean>} True if duplicate
 */
export async function isDuplicate(idempotencyKey) {
  const client = await getRedisClient();
  const exists = await client.exists(idempotencyKey);
  return exists === 1;
}

/**
 * Process a view event with idempotency check
 *
 * This is the main function to use for view event processing.
 * It wraps the idempotency check and provides a clean interface.
 *
 * @param {string} videoId - The video ID
 * @param {string} category - The video category
 * @param {object} options - Options including sessionId and requestId
 * @param {function} processCallback - Async function to call if not duplicate
 * @returns {Promise<{processed: boolean, duplicate: boolean, key: string}>}
 */
export async function processViewWithIdempotency(videoId, category, options, processCallback) {
  const { sessionId, requestId } = options;

  // Generate idempotency key
  const key = generateIdempotencyKey(videoId, sessionId, requestId);

  // Check if duplicate
  const { isDuplicate } = await checkAndMarkProcessed(key);

  if (isDuplicate) {
    // Track duplicate for metrics
    duplicateViewEvents.inc({ category: category || 'all' });

    return {
      processed: false,
      duplicate: true,
      key,
    };
  }

  // Not a duplicate - process the view
  await processCallback();

  return {
    processed: true,
    duplicate: false,
    key,
  };
}

/**
 * Clear an idempotency key (for testing or rollback)
 *
 * @param {string} idempotencyKey - The key to clear
 * @returns {Promise<boolean>} True if key was deleted
 */
export async function clearIdempotencyKey(idempotencyKey) {
  const client = await getRedisClient();
  const result = await client.del(idempotencyKey);
  return result === 1;
}

/**
 * Get statistics about idempotency keys (for monitoring)
 *
 * @returns {Promise<{keyCount: number, memoryBytes: number}>}
 */
export async function getIdempotencyStats() {
  const client = await getRedisClient();

  // Count idempotency keys
  const keys = await client.keys(`${IDEMPOTENCY_CONFIG.keyPrefix}*`);

  return {
    keyCount: keys.length,
    prefix: IDEMPOTENCY_CONFIG.keyPrefix,
    ttlSeconds: IDEMPOTENCY_CONFIG.keyTtlSeconds,
  };
}

export default {
  generateIdempotencyKey,
  checkAndMarkProcessed,
  isDuplicate,
  processViewWithIdempotency,
  clearIdempotencyKey,
  getIdempotencyStats,
};
