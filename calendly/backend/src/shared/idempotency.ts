import { redis } from '../db/index.js';
import { logger } from './logger.js';
import { IDEMPOTENCY_CONFIG } from './config.js';

/**
 * Stored idempotency record in Redis.
 */
interface IdempotencyRecord {
  /** Result of the operation (JSON stringified) */
  result: string;
  /** HTTP status code of the response */
  statusCode: number;
  /** Timestamp when the operation was completed */
  completedAt: string;
}

/**
 * Idempotency check result.
 */
export interface IdempotencyCheckResult {
  /** Whether a previous result was found */
  found: boolean;
  /** Previous result if found */
  result?: unknown;
  /** Previous status code if found */
  statusCode?: number;
}

/**
 * Service for handling idempotent requests.
 *
 * WHY IDEMPOTENCY PREVENTS DOUBLE-BOOKINGS:
 * When a client submits a booking request, network issues or timeouts may cause
 * them to retry the same request. Without idempotency handling:
 * 1. First request succeeds and creates booking A
 * 2. Client doesn't receive response (network timeout)
 * 3. Client retries with identical data
 * 4. Second request could create duplicate booking B
 *
 * With idempotency:
 * 1. First request succeeds, stores result with idempotency key
 * 2. Client doesn't receive response (network timeout)
 * 3. Client retries with same idempotency key
 * 4. System detects duplicate, returns cached result from step 1
 * 5. No duplicate booking created
 *
 * This is especially critical for payments and reservations where duplicates
 * cause real financial or operational impact.
 */
export class IdempotencyService {
  private readonly keyPrefix: string;
  private readonly keyTtlSeconds: number;

  constructor() {
    this.keyPrefix = IDEMPOTENCY_CONFIG.KEY_PREFIX;
    this.keyTtlSeconds = IDEMPOTENCY_CONFIG.KEY_TTL_SECONDS;
  }

  /**
   * Generates the Redis key for an idempotency record.
   * @param idempotencyKey - Client-provided idempotency key
   * @returns Full Redis key
   */
  private getRedisKey(idempotencyKey: string): string {
    return `${this.keyPrefix}${idempotencyKey}`;
  }

  /**
   * Checks if a request with the given idempotency key has already been processed.
   * @param idempotencyKey - Client-provided idempotency key
   * @returns Check result indicating if previous result exists
   */
  async checkIdempotency(idempotencyKey: string): Promise<IdempotencyCheckResult> {
    const redisKey = this.getRedisKey(idempotencyKey);

    try {
      const stored = await redis.get(redisKey);

      if (!stored) {
        return { found: false };
      }

      const record: IdempotencyRecord = JSON.parse(stored);
      logger.debug(
        { idempotencyKey, completedAt: record.completedAt },
        'Found existing idempotency record'
      );

      return {
        found: true,
        result: JSON.parse(record.result),
        statusCode: record.statusCode,
      };
    } catch (error) {
      logger.error({ error, idempotencyKey }, 'Error checking idempotency');
      // On error, allow the request to proceed
      return { found: false };
    }
  }

  /**
   * Stores the result of an idempotent operation.
   * @param idempotencyKey - Client-provided idempotency key
   * @param result - Operation result to cache
   * @param statusCode - HTTP status code of the response
   */
  async storeResult(
    idempotencyKey: string,
    result: unknown,
    statusCode: number
  ): Promise<void> {
    const redisKey = this.getRedisKey(idempotencyKey);

    const record: IdempotencyRecord = {
      result: JSON.stringify(result),
      statusCode,
      completedAt: new Date().toISOString(),
    };

    try {
      await redis.setex(redisKey, this.keyTtlSeconds, JSON.stringify(record));
      logger.debug({ idempotencyKey, statusCode }, 'Stored idempotency record');
    } catch (error) {
      logger.error({ error, idempotencyKey }, 'Error storing idempotency record');
      // Don't throw - the operation succeeded, just caching failed
    }
  }

  /**
   * Acquires a lock for processing an idempotent request.
   * Prevents concurrent processing of requests with the same key.
   * @param idempotencyKey - Client-provided idempotency key
   * @param lockTtlSeconds - Lock timeout in seconds
   * @returns true if lock acquired, false if already locked
   */
  async acquireLock(
    idempotencyKey: string,
    lockTtlSeconds: number = 30
  ): Promise<boolean> {
    const lockKey = `${this.keyPrefix}lock:${idempotencyKey}`;

    try {
      // SET NX returns 'OK' if key was set, null if it already exists
      const result = await redis.set(lockKey, '1', 'EX', lockTtlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      logger.error({ error, idempotencyKey }, 'Error acquiring idempotency lock');
      // On error, allow the request to proceed
      return true;
    }
  }

  /**
   * Releases the lock for an idempotent request.
   * @param idempotencyKey - Client-provided idempotency key
   */
  async releaseLock(idempotencyKey: string): Promise<void> {
    const lockKey = `${this.keyPrefix}lock:${idempotencyKey}`;

    try {
      await redis.del(lockKey);
    } catch (error) {
      logger.error({ error, idempotencyKey }, 'Error releasing idempotency lock');
    }
  }

  /**
   * Generates a unique idempotency key for booking creation.
   * Based on meeting type, time slot, and invitee email.
   * This ensures the same booking attempt gets the same key.
   * @param meetingTypeId - Meeting type UUID
   * @param startTime - Start time ISO string
   * @param inviteeEmail - Invitee's email
   * @returns Generated idempotency key
   */
  static generateBookingKey(
    meetingTypeId: string,
    startTime: string,
    inviteeEmail: string
  ): string {
    // Normalize email to lowercase
    const normalizedEmail = inviteeEmail.toLowerCase().trim();
    // Combine into a deterministic key
    return `booking:${meetingTypeId}:${startTime}:${normalizedEmail}`;
  }
}

/**
 * Singleton instance of IdempotencyService.
 */
export const idempotencyService = new IdempotencyService();

export default idempotencyService;
