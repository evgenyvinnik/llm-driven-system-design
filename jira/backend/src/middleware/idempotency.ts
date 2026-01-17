import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis.js';
import { logger } from '../config/logger.js';
import { idempotentReplaysCounter } from '../config/metrics.js';

/**
 * Idempotency key header name.
 * Clients should include this header with a unique identifier (e.g., UUID)
 * to enable idempotent request handling.
 */
export const IDEMPOTENCY_HEADER = 'x-idempotency-key';

/**
 * TTL for idempotency keys in seconds (24 hours).
 * After this period, the same key can be reused.
 */
const IDEMPOTENCY_TTL = 24 * 60 * 60; // 24 hours

/**
 * Redis key prefix for idempotency storage.
 */
const IDEMPOTENCY_PREFIX = 'jira:idempotency:';

/**
 * Stored response for idempotent requests.
 */
interface StoredResponse {
  /** HTTP status code */
  status: number;
  /** Response body */
  body: unknown;
  /** Timestamp when response was stored */
  created_at: string;
  /** Request path that generated this response */
  request_path: string;
  /** HTTP method */
  request_method: string;
}

/**
 * Status indicating request is being processed.
 */
interface ProcessingStatus {
  status: 'processing';
  started_at: string;
}

type IdempotencyValue = StoredResponse | ProcessingStatus;

/**
 * Middleware for handling idempotent requests.
 *
 * WHY: Idempotency prevents duplicate issues from webhook retries and network failures.
 * When a client sends a request with an X-Idempotency-Key header, this middleware:
 * 1. Checks if we've already processed a request with this key
 * 2. If yes, returns the cached response (replay)
 * 3. If no, processes the request and caches the response
 *
 * This is critical for:
 * - Webhook integrations that may retry on timeout
 * - Mobile apps with flaky network connections
 * - CI/CD pipelines creating issues programmatically
 *
 * @param req - Express request
 * @param res - Express response
 * @param next - Next middleware function
 */
export async function idempotencyMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const idempotencyKey = req.headers[IDEMPOTENCY_HEADER] as string | undefined;

  // Skip if no idempotency key provided (non-idempotent request)
  if (!idempotencyKey) {
    return next();
  }

  // Validate key format (must be non-empty, reasonable length)
  if (idempotencyKey.length < 1 || idempotencyKey.length > 256) {
    res.status(400).json({ error: 'Invalid idempotency key length' });
    return;
  }

  const userId = req.session?.userId || 'anonymous';
  const cacheKey = `${IDEMPOTENCY_PREFIX}${userId}:${idempotencyKey}`;

  try {
    // Check for existing response or processing status
    const existing = await redis.get(cacheKey);

    if (existing) {
      const value: IdempotencyValue = JSON.parse(existing);

      if ('status' in value && value.status === 'processing') {
        // Request is still being processed - return conflict
        logger.debug({ idempotencyKey, userId }, 'Idempotent request still processing');
        res.status(409).json({
          error: 'Request with this idempotency key is still processing',
          retry_after: 5,
        });
        return;
      }

      // Return cached response (replay)
      const storedResponse = value as StoredResponse;

      // Verify the request path and method match
      if (
        storedResponse.request_path !== req.path ||
        storedResponse.request_method !== req.method
      ) {
        res.status(422).json({
          error: 'Idempotency key was used with a different request',
          original_path: storedResponse.request_path,
          original_method: storedResponse.request_method,
        });
        return;
      }

      logger.info({ idempotencyKey, userId }, 'Replaying idempotent response');
      idempotentReplaysCounter.inc();

      res.status(storedResponse.status).json(storedResponse.body);
      return;
    }

    // Mark request as processing
    const processingStatus: ProcessingStatus = {
      status: 'processing',
      started_at: new Date().toISOString(),
    };
    await redis.setex(cacheKey, 60, JSON.stringify(processingStatus)); // 1 minute lock

    // Intercept response to capture and store it
    const originalJson = res.json.bind(res);
    res.json = function (body: unknown) {
      // Store the response for future replays
      const storedResponse: StoredResponse = {
        status: res.statusCode,
        body,
        created_at: new Date().toISOString(),
        request_path: req.path,
        request_method: req.method,
      };

      redis.setex(cacheKey, IDEMPOTENCY_TTL, JSON.stringify(storedResponse)).catch((err) => {
        logger.error({ err, idempotencyKey }, 'Failed to store idempotent response');
      });

      return originalJson(body);
    };

    next();
  } catch (error) {
    logger.error({ err: error, idempotencyKey }, 'Idempotency check failed');
    // On error, proceed without idempotency (fail open)
    next();
  }
}

/**
 * Clears an idempotency key (useful for testing or manual cleanup).
 *
 * @param userId - User ID
 * @param idempotencyKey - The idempotency key to clear
 */
export async function clearIdempotencyKey(userId: string, idempotencyKey: string): Promise<void> {
  const cacheKey = `${IDEMPOTENCY_PREFIX}${userId}:${idempotencyKey}`;
  await redis.del(cacheKey);
}

/**
 * Gets the stored response for an idempotency key (for debugging).
 *
 * @param userId - User ID
 * @param idempotencyKey - The idempotency key to look up
 * @returns Stored response or null
 */
export async function getIdempotencyStatus(
  userId: string,
  idempotencyKey: string
): Promise<IdempotencyValue | null> {
  const cacheKey = `${IDEMPOTENCY_PREFIX}${userId}:${idempotencyKey}`;
  const data = await redis.get(cacheKey);
  return data ? JSON.parse(data) : null;
}

export default idempotencyMiddleware;
