import { Request, Response, NextFunction } from 'express';
import { redis } from '../config/redis.js';
import { logger } from './logger.js';
import { cacheTTLConfig } from './retention.js';
import { idempotencyOperations } from './metrics.js';

/**
 * Idempotency for health data ingestion.
 *
 * WHY: Idempotency is critical for health data pipelines because:
 * - Mobile devices often retry failed requests (network issues)
 * - Users may accidentally trigger multiple syncs
 * - Duplicate data corrupts aggregations and insights
 * - HIPAA requires accurate data records
 *
 * Implementation:
 * - Client sends an idempotency key (usually hash of samples + timestamp)
 * - Server checks if key was seen before
 * - If seen: return cached response (no re-processing)
 * - If new: process request, cache response with TTL
 *
 * This is superior to just ON CONFLICT DO NOTHING because:
 * - Prevents wasted processing (validation, aggregation)
 * - Reduces database load
 * - Provides consistent responses to retries
 */

const IDEMPOTENCY_PREFIX = cacheTTLConfig.idempotency.prefix;
const IDEMPOTENCY_TTL = cacheTTLConfig.idempotency.ttlSeconds;

interface IdempotencyCheckResult {
  isDuplicate: boolean;
  cachedResponse: unknown;
}

interface SampleData {
  type: string;
  value: number;
  startDate: Date | string;
  endDate?: Date | string;
}

/**
 * Check if a request is a duplicate based on idempotency key.
 */
export async function checkIdempotency(idempotencyKey: string): Promise<IdempotencyCheckResult> {
  if (!idempotencyKey) {
    return { isDuplicate: false, cachedResponse: null };
  }

  const cacheKey = `${IDEMPOTENCY_PREFIX}${idempotencyKey}`;

  try {
    const cached = await redis.get(cacheKey);

    if (cached) {
      idempotencyOperations.inc({ result: 'duplicate' });
      logger.info({
        msg: 'Duplicate request detected',
        idempotencyKey
      });
      return { isDuplicate: true, cachedResponse: JSON.parse(cached) };
    }

    return { isDuplicate: false, cachedResponse: null };
  } catch (error) {
    // On cache error, proceed with request (fail open)
    logger.warn({
      msg: 'Idempotency check failed, proceeding',
      error: (error as Error).message,
      idempotencyKey
    });
    return { isDuplicate: false, cachedResponse: null };
  }
}

/**
 * Store idempotency key and response.
 */
export async function storeIdempotencyKey(idempotencyKey: string, response: unknown): Promise<void> {
  if (!idempotencyKey) {
    return;
  }

  const cacheKey = `${IDEMPOTENCY_PREFIX}${idempotencyKey}`;

  try {
    await redis.setex(cacheKey, IDEMPOTENCY_TTL, JSON.stringify(response));
    idempotencyOperations.inc({ result: 'new' });

    logger.debug({
      msg: 'Stored idempotency key',
      idempotencyKey,
      ttl: IDEMPOTENCY_TTL
    });
  } catch (error) {
    // Log but don't fail the request
    logger.warn({
      msg: 'Failed to store idempotency key',
      error: (error as Error).message,
      idempotencyKey
    });
  }
}

/**
 * Generate an idempotency key from request data.
 * Combines user ID, device ID, and content hash.
 */
export function generateIdempotencyKey(userId: string, deviceId: string, samples: SampleData[]): string {
  // Create a deterministic hash of the samples
  const sampleSignature = samples.map(s => ({
    type: s.type,
    value: s.value,
    startDate: s.startDate,
    endDate: s.endDate
  }));

  // Simple hash function (for production, use crypto.createHash)
  const contentHash = simpleHash(JSON.stringify(sampleSignature));

  return `${userId}:${deviceId}:${contentHash}`;
}

/**
 * Simple hash function for idempotency keys.
 * For production, consider using crypto.createHash('sha256').
 */
function simpleHash(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(36);
}

interface ExtendedResponse extends Response {
  json: (data: unknown) => Response;
}

/**
 * Express middleware for idempotent POST requests.
 * Checks X-Idempotency-Key header.
 */
export function idempotencyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;

  if (!idempotencyKey) {
    // No idempotency key provided, proceed normally
    next();
    return;
  }

  // Check for duplicate
  checkIdempotency(idempotencyKey)
    .then(({ isDuplicate, cachedResponse }) => {
      if (isDuplicate) {
        // Return cached response
        res.json(cachedResponse);
        return;
      }

      // Store original res.json to intercept response
      const originalJson = res.json.bind(res);
      (res as ExtendedResponse).json = (data: unknown): Response => {
        // Store the response for future duplicates
        storeIdempotencyKey(idempotencyKey, data)
          .catch(err => logger.error({ msg: 'Failed to cache response', error: (err as Error).message }));

        return originalJson(data);
      };

      next();
    })
    .catch((error: Error) => {
      logger.error({ msg: 'Idempotency middleware error', error: error.message });
      next();
    });
}

/**
 * Clean up expired idempotency keys.
 * Not strictly necessary (Redis handles TTL), but useful for monitoring.
 */
export async function cleanupExpiredKeys(): Promise<number> {
  // Redis handles TTL automatically, but we can scan for stats
  const keys = await redis.keys(`${IDEMPOTENCY_PREFIX}*`);
  logger.info({
    msg: 'Active idempotency keys',
    count: keys.length
  });
  return keys.length;
}

export default {
  checkIdempotency,
  storeIdempotencyKey,
  generateIdempotencyKey,
  idempotencyMiddleware,
  cleanupExpiredKeys
};
