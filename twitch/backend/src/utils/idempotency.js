/**
 * Idempotency Support
 *
 * Prevents duplicate processing of requests by:
 * - Tracking processed request IDs
 * - Returning cached results for duplicate requests
 * - Supporting both client-provided and server-generated keys
 *
 * Use cases:
 * - Chat messages: Prevent duplicate messages from network retries
 * - Subscriptions: Prevent double-charging from payment retries
 * - Stream start: Prevent duplicate "go live" events from RTMP reconnects
 */
const { logger } = require('./logger');
const { incChatDeduped, incSubscriptionDeduped } = require('./metrics');

// Default TTL for idempotency keys (5 minutes for chat, 24 hours for subscriptions)
const CHAT_DEDUP_TTL_SECONDS = 300;
const SUBSCRIPTION_DEDUP_TTL_SECONDS = 86400;
const STREAM_LOCK_TTL_SECONDS = 10;

/**
 * Check if a chat message has already been processed (deduplication)
 *
 * @param {Object} redis - Redis client
 * @param {number} channelId - Channel ID
 * @param {string} messageId - Unique message ID (provided by client)
 * @returns {Promise<{isNew: boolean, dropped: boolean}>}
 */
async function checkChatMessageDedup(redis, channelId, messageId) {
  if (!messageId) {
    // No message ID provided, cannot deduplicate
    return { isNew: true, dropped: false };
  }

  const dedupKey = `chat_dedup:${channelId}`;

  try {
    // SADD returns 1 if the element is new, 0 if it already exists
    const result = await redis.sAdd(dedupKey, messageId);

    // Set TTL on the set (refresh on each message)
    await redis.expire(dedupKey, CHAT_DEDUP_TTL_SECONDS);

    if (result === 0) {
      logger.debug({
        channel_id: channelId,
        message_id: messageId
      }, 'duplicate chat message dropped');
      incChatDeduped();
      return { isNew: false, dropped: true };
    }

    return { isNew: true, dropped: false };
  } catch (error) {
    // Redis error - allow message through (fail open)
    logger.warn({
      error: error.message,
      channel_id: channelId
    }, 'chat dedup check failed - allowing message');
    return { isNew: true, dropped: false };
  }
}

/**
 * Generate a unique message ID for chat
 * Clients should use this format or provide their own unique ID
 *
 * @param {number} userId - User ID
 * @returns {string} Unique message ID
 */
function generateChatMessageId(userId) {
  return `${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Check if a subscription request has already been processed
 * Returns cached result if duplicate
 *
 * @param {Object} redis - Redis client
 * @param {string} idempotencyKey - Client-provided idempotency key
 * @returns {Promise<{isDuplicate: boolean, cachedResult: any|null}>}
 */
async function checkSubscriptionIdempotency(redis, idempotencyKey) {
  if (!idempotencyKey) {
    return { isDuplicate: false, cachedResult: null };
  }

  const key = `idempotency:sub:${idempotencyKey}`;

  try {
    const cached = await redis.get(key);

    if (cached) {
      logger.info({ idempotency_key: idempotencyKey }, 'duplicate subscription request detected');
      incSubscriptionDeduped();
      return { isDuplicate: true, cachedResult: JSON.parse(cached) };
    }

    return { isDuplicate: false, cachedResult: null };
  } catch (error) {
    logger.warn({
      error: error.message,
      idempotency_key: idempotencyKey
    }, 'subscription idempotency check failed');
    return { isDuplicate: false, cachedResult: null };
  }
}

/**
 * Store subscription result for idempotency
 *
 * @param {Object} redis - Redis client
 * @param {string} idempotencyKey - Client-provided idempotency key
 * @param {Object} result - Result to cache
 * @returns {Promise<void>}
 */
async function storeSubscriptionResult(redis, idempotencyKey, result) {
  if (!idempotencyKey) return;

  const key = `idempotency:sub:${idempotencyKey}`;

  try {
    await redis.set(key, JSON.stringify(result), { EX: SUBSCRIPTION_DEDUP_TTL_SECONDS });
    logger.debug({ idempotency_key: idempotencyKey }, 'subscription result cached');
  } catch (error) {
    logger.warn({
      error: error.message,
      idempotency_key: idempotencyKey
    }, 'failed to cache subscription result');
  }
}

/**
 * Acquire a lock for stream operations (prevent duplicate go-live events)
 *
 * @param {Object} redis - Redis client
 * @param {number} channelId - Channel ID
 * @returns {Promise<{acquired: boolean}>}
 */
async function acquireStreamLock(redis, channelId) {
  const lockKey = `stream_lock:${channelId}`;

  try {
    // SET NX (only if not exists) with expiration
    const result = await redis.set(lockKey, Date.now().toString(), {
      NX: true,
      EX: STREAM_LOCK_TTL_SECONDS
    });

    if (!result) {
      logger.warn({ channel_id: channelId }, 'stream lock acquisition failed - another operation in progress');
      return { acquired: false };
    }

    return { acquired: true };
  } catch (error) {
    logger.warn({
      error: error.message,
      channel_id: channelId
    }, 'stream lock check failed');
    return { acquired: false };
  }
}

/**
 * Release a stream lock
 *
 * @param {Object} redis - Redis client
 * @param {number} channelId - Channel ID
 * @returns {Promise<void>}
 */
async function releaseStreamLock(redis, channelId) {
  const lockKey = `stream_lock:${channelId}`;

  try {
    await redis.del(lockKey);
  } catch (error) {
    logger.warn({
      error: error.message,
      channel_id: channelId
    }, 'failed to release stream lock');
  }
}

/**
 * Generate an idempotency key for subscriptions
 * Format: sub:{userId}:{channelId}:{timestamp}
 *
 * @param {number} userId - User ID
 * @param {number} channelId - Channel ID
 * @returns {string}
 */
function generateSubscriptionIdempotencyKey(userId, channelId) {
  return `sub:${userId}:${channelId}:${Date.now()}`;
}

/**
 * Express middleware to extract idempotency key from request
 */
function extractIdempotencyKey(req, res, next) {
  // Check common header names for idempotency key
  req.idempotencyKey =
    req.headers['idempotency-key'] ||
    req.headers['x-idempotency-key'] ||
    req.headers['x-request-id'] ||
    null;

  next();
}

module.exports = {
  checkChatMessageDedup,
  generateChatMessageId,
  checkSubscriptionIdempotency,
  storeSubscriptionResult,
  acquireStreamLock,
  releaseStreamLock,
  generateSubscriptionIdempotencyKey,
  extractIdempotencyKey,
  CHAT_DEDUP_TTL_SECONDS,
  SUBSCRIPTION_DEDUP_TTL_SECONDS,
  STREAM_LOCK_TTL_SECONDS
};
