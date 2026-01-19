import Redis from 'ioredis';
import { Request, Response, NextFunction } from 'express';
import redis from '../redis.js';
import { query } from '../db.js';
import { createLogger } from './logger.js';
import { idempotentRequests } from './metrics.js';

const logger = createLogger('idempotency');

interface IdempotencyCheckResult {
  exists: boolean;
  messageId?: string;
  status?: string;
}

interface IdempotencyProcessResult<T> {
  result: T;
  isDuplicate: boolean;
}

interface ProcessOptions<T> {
  idempotencyKey: string;
  userId: string;
  operation: () => Promise<T>;
}

interface AuthenticatedRequest extends Request {
  user?: { id: string; [key: string]: unknown };
  idempotencyKey?: string | null;
}

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
  private redis: Redis;
  private keyPrefix: string;
  private ttlSeconds: number;

  constructor(redisClient: Redis) {
    this.redis = redisClient;
    this.keyPrefix = 'idempotency:';
    this.ttlSeconds = 24 * 60 * 60; // 24 hours
  }

  /**
   * Generate an idempotency key for a message
   */
  generateKey(userId: string, conversationId: string, clientMessageId: string): string {
    return `${userId}:${conversationId}:${clientMessageId}`;
  }

  /**
   * Check if a request with this idempotency key has already been processed
   */
  async checkExisting(idempotencyKey: string): Promise<IdempotencyCheckResult> {
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
   */
  async recordCompletion(idempotencyKey: string, messageId: string, userId: string): Promise<void> {
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
   */
  async processWithIdempotency<T extends { id: string }>(
    options: ProcessOptions<T>
  ): Promise<IdempotencyProcessResult<T | { id: string; status?: string }>> {
    const { idempotencyKey, userId, operation } = options;

    // Check for existing
    const existing = await this.checkExisting(idempotencyKey);

    if (existing.exists) {
      idempotentRequests.inc({ result: 'duplicate' });
      logger.info({ idempotencyKey, messageId: existing.messageId }, 'Duplicate request detected');

      return {
        result: { id: existing.messageId!, status: existing.status },
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
const idempotencyService = new IdempotencyService(redis);

/**
 * Express middleware for idempotent message sending
 * Expects idempotencyKey in request body or X-Idempotency-Key header
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authReq = req as AuthenticatedRequest;
  // Extract or generate idempotency key
  const clientMessageId = req.body.clientMessageId || req.headers['x-idempotency-key'];

  if (!clientMessageId) {
    // No idempotency key provided - generate a warning but allow
    logger.warn({
      userId: authReq.user?.id,
      method: req.method,
      url: req.url,
    }, 'Request without idempotency key');
  }

  // Attach to request for use in handlers
  authReq.idempotencyKey = clientMessageId
    ? idempotencyService.generateKey(
        authReq.user?.id || 'anonymous',
        req.params.conversationId || 'unknown',
        clientMessageId as string
      )
    : null;

  next();
}

export default idempotencyService;
