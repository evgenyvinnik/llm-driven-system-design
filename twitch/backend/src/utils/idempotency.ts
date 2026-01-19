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
import { Request, Response, NextFunction } from 'express';
import type { RedisClientType } from 'redis';
import { logger } from './logger.js';
import { incChatDeduped, incSubscriptionDeduped } from './metrics.js';

// Default TTL for idempotency keys (5 minutes for chat, 24 hours for subscriptions)
const CHAT_DEDUP_TTL_SECONDS = 300;
const SUBSCRIPTION_DEDUP_TTL_SECONDS = 86400;
const STREAM_LOCK_TTL_SECONDS = 10;

interface ChatDedupResult {
  isNew: boolean;
  dropped: boolean;
}

/**
 * Check if a chat message has already been processed (deduplication)
 */
async function checkChatMessageDedup(
  redis: RedisClientType,
  channelId: string | number,
  messageId: string
): Promise<ChatDedupResult> {
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
      error: (error as Error).message,
      channel_id: channelId
    }, 'chat dedup check failed - allowing message');
    return { isNew: true, dropped: false };
  }
}

/**
 * Generate a unique message ID for chat
 * Clients should use this format or provide their own unique ID
 */
function generateChatMessageId(userId: string | number): string {
  return `${userId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
}

interface SubscriptionIdempotencyResult {
  isDuplicate: boolean;
  cachedResult: unknown | null;
}

/**
 * Check if a subscription request has already been processed
 * Returns cached result if duplicate
 */
async function checkSubscriptionIdempotency(
  redis: RedisClientType,
  idempotencyKey: string
): Promise<SubscriptionIdempotencyResult> {
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
      error: (error as Error).message,
      idempotency_key: idempotencyKey
    }, 'subscription idempotency check failed');
    return { isDuplicate: false, cachedResult: null };
  }
}

/**
 * Store subscription result for idempotency
 */
async function storeSubscriptionResult(
  redis: RedisClientType,
  idempotencyKey: string,
  result: unknown
): Promise<void> {
  if (!idempotencyKey) return;

  const key = `idempotency:sub:${idempotencyKey}`;

  try {
    await redis.set(key, JSON.stringify(result), { EX: SUBSCRIPTION_DEDUP_TTL_SECONDS });
    logger.debug({ idempotency_key: idempotencyKey }, 'subscription result cached');
  } catch (error) {
    logger.warn({
      error: (error as Error).message,
      idempotency_key: idempotencyKey
    }, 'failed to cache subscription result');
  }
}

interface StreamLockResult {
  acquired: boolean;
}

/**
 * Acquire a lock for stream operations (prevent duplicate go-live events)
 */
async function acquireStreamLock(
  redis: RedisClientType,
  channelId: string | number
): Promise<StreamLockResult> {
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
      error: (error as Error).message,
      channel_id: channelId
    }, 'stream lock check failed');
    return { acquired: false };
  }
}

/**
 * Release a stream lock
 */
async function releaseStreamLock(
  redis: RedisClientType,
  channelId: string | number
): Promise<void> {
  const lockKey = `stream_lock:${channelId}`;

  try {
    await redis.del(lockKey);
  } catch (error) {
    logger.warn({
      error: (error as Error).message,
      channel_id: channelId
    }, 'failed to release stream lock');
  }
}

/**
 * Generate an idempotency key for subscriptions
 * Format: sub:{userId}:{channelId}:{timestamp}
 */
function generateSubscriptionIdempotencyKey(userId: number, channelId: number): string {
  return `sub:${userId}:${channelId}:${Date.now()}`;
}

/**
 * Express middleware to extract idempotency key from request
 */
function extractIdempotencyKey(req: Request, _res: Response, next: NextFunction): void {
  // Check common header names for idempotency key
  req.idempotencyKey =
    (req.headers['idempotency-key'] as string) ||
    (req.headers['x-idempotency-key'] as string) ||
    (req.headers['x-request-id'] as string) ||
    null;

  next();
}

export {
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
