import redis from '../redis.js';
import { query } from '../db.js';
import { createLogger } from './logger.js';
import { idempotentRequests } from './metrics.js';

const logger = createLogger('idempotency');

/**
 * Idempotency service for preventing duplicate message delivery
 *
 * WHY: In distributed messaging systems, network failures and retries can cause
 * the same message to be sent multiple times. Without idempotency handling,
 * this leads to duplicate messages appearing in conversations, confusing users
 * and corrupting conversation history.
 *
 * The idempotency key strategy uses a combination of:
 * - Client-generated message ID (UUID)
 * - User ID
 * - Conversation ID
 *
 * This ensures that even if a client retries the same request, the server
 * will recognize it as a duplicate and return the existing message.
 */
export class IdempotencyService {
  constructor(redisClient, dbPool) {
    this.redis = redisClient;
    this.db = dbPool;
    this.keyPrefix = 'idempotency:';
    this.ttlSeconds = 24 * 60 * 60; // 24 hours
  }

  /**
   * Generate an idempotency key for a message
   * @param {string} userId - Sender's user ID
   * @param {string} conversationId - Conversation ID
   * @param {string} clientMessageId - Client-generated message ID
   */
  generateKey(userId, conversationId, clientMessageId) {
    return `${userId}:${conversationId}:${clientMessageId}`;
  }

  /**
   * Check if a request with this idempotency key has already been processed
   * @param {string} idempotencyKey - The idempotency key
   * @returns {Promise<{exists: boolean, messageId?: string, status?: string}>}
   */
  async checkExisting(idempotencyKey) {
    const fullKey = `${this.keyPrefix}${idempotencyKey}`;

    try {
      // First check Redis cache for fast lookup
      const cached = await this.redis.get(fullKey);
      if (cached) {
        const data = JSON.parse(cached);
        logger.debug({ idempotencyKey, messageId: data.messageId }, 'Idempotency cache hit');
        return { exists: true, messageId: data.messageId, status: data.status };
      }

      // Check database for persistence (in case Redis was restarted)
      const result = await query(
        `SELECT result_id as message_id, status
         FROM idempotency_keys
         WHERE key = $1 AND created_at > NOW() - INTERVAL '24 hours'`,
        [idempotencyKey]
      );

      if (result.rows.length > 0) {
        const { message_id, status } = result.rows[0];

        // Re-cache in Redis
        await this.redis.setex(fullKey, this.ttlSeconds, JSON.stringify({
          messageId: message_id,
          status: status || 'completed',
        }));

        logger.debug({ idempotencyKey, messageId: message_id }, 'Idempotency DB hit');
        return { exists: true, messageId: message_id, status: status || 'completed' };
      }

      return { exists: false };
    } catch (error) {
      logger.error({ error, idempotencyKey }, 'Idempotency check failed');
      // Fail open - proceed with the request
      return { exists: false };
    }
  }

  /**
   * Record a completed operation with its idempotency key
   * @param {string} idempotencyKey - The idempotency key
   * @param {string} messageId - The resulting message ID
   * @param {string} userId - The user who made the request
   */
  async recordCompletion(idempotencyKey, messageId, userId) {
    const fullKey = `${this.keyPrefix}${idempotencyKey}`;

    try {
      // Store in Redis for fast lookup
      await this.redis.setex(fullKey, this.ttlSeconds, JSON.stringify({
        messageId,
        status: 'completed',
        completedAt: new Date().toISOString(),
      }));

      // Store in database for durability
      await query(
        `INSERT INTO idempotency_keys (key, user_id, result_id, status, created_at)
         VALUES ($1, $2, $3, 'completed', NOW())
         ON CONFLICT (key) DO UPDATE SET result_id = $3, status = 'completed'`,
        [idempotencyKey, userId, messageId]
      );

      idempotentRequests.inc({ result: 'new' });
      logger.debug({ idempotencyKey, messageId }, 'Idempotency key recorded');
    } catch (error) {
      logger.error({ error, idempotencyKey, messageId }, 'Failed to record idempotency key');
      // Non-fatal error - continue processing
    }
  }

  /**
   * Process a request with idempotency handling
   * @param {Object} options - Processing options
   * @param {string} options.idempotencyKey - The idempotency key
   * @param {string} options.userId - The user making the request
   * @param {Function} options.operation - The async operation to perform
   * @returns {Promise<{result: any, isDuplicate: boolean}>}
   */
  async processWithIdempotency({ idempotencyKey, userId, operation }) {
    // Check for existing
    const existing = await this.checkExisting(idempotencyKey);

    if (existing.exists) {
      idempotentRequests.inc({ result: 'duplicate' });
      logger.info({ idempotencyKey, messageId: existing.messageId }, 'Duplicate request detected');

      return {
        result: { id: existing.messageId, status: existing.status },
        isDuplicate: true,
      };
    }

    try {
      // Perform the operation
      const result = await operation();

      // Record completion
      await this.recordCompletion(idempotencyKey, result.id, userId);

      return { result, isDuplicate: false };
    } catch (error) {
      idempotentRequests.inc({ result: 'error' });
      throw error;
    }
  }
}

// Create singleton instance
const idempotencyService = new IdempotencyService(redis, null);

/**
 * Express middleware for idempotent message sending
 * Expects idempotencyKey in request body or X-Idempotency-Key header
 */
export function idempotencyMiddleware(req, res, next) {
  // Extract or generate idempotency key
  const clientMessageId = req.body.clientMessageId || req.headers['x-idempotency-key'];

  if (!clientMessageId) {
    // No idempotency key provided - generate a warning but allow
    logger.warn({
      userId: req.user?.id,
      method: req.method,
      url: req.url,
    }, 'Request without idempotency key');
  }

  // Attach to request for use in handlers
  req.idempotencyKey = clientMessageId
    ? idempotencyService.generateKey(
        req.user?.id || 'anonymous',
        req.params.conversationId || 'unknown',
        clientMessageId
      )
    : null;

  next();
}

export default idempotencyService;
