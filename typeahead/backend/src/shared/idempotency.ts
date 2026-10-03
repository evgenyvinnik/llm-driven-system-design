/**
 * Idempotency handler for write operations.
 *
 * WHY idempotency is CRITICAL for typeahead index updates:
 * - Prevents duplicate phrase count increments on retry
 * - Enables safe replay of failed operations
 * - Supports at-least-once delivery semantics
 * - Allows clients to safely retry without side effects
 */
import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Redis } from 'ioredis';
import logger, { auditLogger } from './logger.js';
import { idempotencyMetrics } from './metrics.js';

interface IdempotencyEntry {
  record: IdempotencyRecord;
  expiresAt: number;
}

interface CachedResult {
  statusCode: number;
  body: unknown;
}

/**
 * What the middleware keeps per (operation, client key): a reservation while the first
 * request runs, then its response. The fingerprint (params + body hash) detects a key
 * reused for a different request.
 */
type IdempotencyRecord =
  | { state: 'pending'; fingerprint: string; token: string }
  | { state: 'done'; fingerprint: string; result: CachedResult };

interface IdempotencyHandlerOptions {
  prefix?: string;
  expirySeconds?: number;
}

interface ProcessResult<T> {
  processed: boolean;
  duplicate: boolean;
  result: T;
}

// Extend Express Request to include idempotencyKey
declare global {
  namespace Express {
    interface Request {
      idempotencyKey?: string;
    }
  }
}

// Stored responses are replayed for 5 minutes
const RESULT_TTL_MS = 5 * 60 * 1000;
// A reservation outlives a stuck or crashed handler by at most this long
const PENDING_TTL_MS = 60 * 1000;
// Longest accepted X-Idempotency-Key (a UUID is 36 characters)
const MAX_KEY_LENGTH = 128;
// Redis key prefix for the middleware's records (RedisIdempotencyHandler uses 'idem:')
const REDIS_PREFIX = 'idem:http:';

// Delete a reservation only if it is still the one this request made
const RELEASE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current and cjson.decode(current).token == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * In-memory idempotency store with TTL.
 * Used when Redis is unavailable; Redis gives deduplication across instances.
 */
class IdempotencyStore {
  private store: Map<string, IdempotencyEntry> = new Map();
  private cleanupInterval: number = 60 * 1000; // Clean up every minute
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Periodic cleanup
    this.cleanupTimer = setInterval(() => this.cleanup(), this.cleanupInterval);
    this.cleanupTimer.unref();
  }

  /**
   * Store the record unless a live one exists (SET NX). Returns the existing record, or
   * null when this call reserved the key.
   */
  setIfAbsent(key: string, record: IdempotencyRecord, ttlMs: number): IdempotencyRecord | null {
    const existing = this.get(key);
    if (existing) return existing;
    this.set(key, record, ttlMs);
    return null;
  }

  set(key: string, record: IdempotencyRecord, ttlMs: number): void {
    this.store.set(key, { record, expiresAt: Date.now() + ttlMs });
  }

  get(key: string): IdempotencyRecord | null {
    const entry = this.store.get(key);
    if (!entry) return null;

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }

    return entry.record;
  }

  /**
   * Remove a reservation, unless it has since been replaced by another request's.
   */
  release(key: string, token: string): void {
    const record = this.get(key);
    if (record?.state === 'pending' && record.token === token) {
      this.store.delete(key);
    }
  }

  cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }
}

// Global in-memory store
const inMemoryStore = new IdempotencyStore();

/**
 * Generate an idempotency key from request data
 */
export function generateIdempotencyKey(operation: string, data: Record<string, unknown>): string {
  const payload = JSON.stringify({
    operation,
    ...data,
    // Don't include timestamp for idempotency
  });

  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * Where a request's idempotency record lives: Redis when it is connected (shared by every
 * instance), otherwise this process's memory.
 */
interface RecordStore {
  reserve(key: string, record: IdempotencyRecord): Promise<IdempotencyRecord | null>;
  complete(key: string, record: IdempotencyRecord): Promise<void>;
  release(key: string, token: string): Promise<void>;
}

const memoryRecordStore: RecordStore = {
  reserve: async (key, record) => inMemoryStore.setIfAbsent(key, record, PENDING_TTL_MS),
  complete: async (key, record) => inMemoryStore.set(key, record, RESULT_TTL_MS),
  release: async (key, token) => inMemoryStore.release(key, token),
};

function redisRecordStore(redis: Redis): RecordStore {
  return {
    async reserve(key, record) {
      const redisKey = REDIS_PREFIX + key;
      const reserved = await redis.set(redisKey, JSON.stringify(record), 'PX', PENDING_TTL_MS, 'NX');
      if (reserved) return null;
      const existing = await redis.get(redisKey);
      // The other record expired between SET and GET: try once more
      if (!existing) {
        const retry = await redis.set(redisKey, JSON.stringify(record), 'PX', PENDING_TTL_MS, 'NX');
        return retry ? null : { state: 'pending', fingerprint: record.fingerprint, token: '' };
      }
      return JSON.parse(existing) as IdempotencyRecord;
    },
    async complete(key, record) {
      await redis.set(REDIS_PREFIX + key, JSON.stringify(record), 'PX', RESULT_TTL_MS);
    },
    async release(key, token) {
      await redis.eval(RELEASE_SCRIPT, 1, REDIS_PREFIX + key, token);
    },
  };
}

/**
 * Pick Redis when the app has a connected client; an offline ioredis client would queue
 * the command and stall the request through its reconnect retries.
 */
function getRecordStore(req: Request): RecordStore {
  const redis = req.app.get('redis') as Redis | undefined;
  return redis?.status === 'ready' ? redisRecordStore(redis) : memoryRecordStore;
}

/**
 * Middleware to handle idempotency for POST/PUT/DELETE requests.
 *
 * Deduplicates only requests that carry an X-Idempotency-Key header: the client generates
 * one per user action and reuses it only when retrying that action. A request without the
 * header runs normally, so an admin can deliberately repeat an operation (re-filter after an
 * unfilter, a second cache clear). Keys are scoped by operation.
 *
 * - First request with a key: reserves it (SET NX), runs, and stores a 2xx-4xx response
 *   for 5 minutes. A 5xx is not stored, so a retry runs again.
 * - Retry after completion: the stored response is replayed (Idempotency-Replayed: true).
 * - Duplicate while the first is still running: 409 with Retry-After.
 * - Same key with different params/body: 422.
 */
export function idempotencyMiddleware(
  operation: string
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const clientKey = req.get('X-Idempotency-Key')?.trim();

    // No key: not a retry of an earlier request, so nothing to deduplicate
    if (clientKey === undefined) {
      next();
      return;
    }

    if (!clientKey || clientKey.length > MAX_KEY_LENGTH) {
      res.status(400).json({
        error: `X-Idempotency-Key must be 1-${MAX_KEY_LENGTH} characters`,
      });
      return;
    }

    req.idempotencyKey = clientKey;
    const storeKey = `${operation}:${clientKey}`;
    const fingerprint = crypto
      .createHash('sha256')
      .update(JSON.stringify({ params: req.params, body: req.body ?? null }))
      .digest('hex');
    const token = crypto.randomUUID();

    let store = getRecordStore(req);
    let existing: IdempotencyRecord | null;
    try {
      existing = await store.reserve(storeKey, { state: 'pending', fingerprint, token });
    } catch (error) {
      logger.warn({
        event: 'idempotency_store_fallback',
        operation,
        error: (error as Error).message,
      });
      store = memoryRecordStore;
      existing = await store.reserve(storeKey, { state: 'pending', fingerprint, token });
    }

    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        res.status(422).json({
          error: 'X-Idempotency-Key was already used for a different request',
        });
        return;
      }

      if (existing.state === 'pending') {
        logger.info({ event: 'idempotency_in_progress', idempotencyKey: clientKey, operation });
        res.set('Retry-After', '1');
        res.status(409).json({
          error: 'A request with this X-Idempotency-Key is still being processed',
        });
        return;
      }

      auditLogger.logIdempotencySkip(clientKey, operation);
      idempotencyMetrics.duplicates.inc({ operation });

      logger.info({
        event: 'idempotency_duplicate',
        idempotencyKey: clientKey,
        operation,
      });

      // Return cached result
      res.set('Idempotency-Replayed', 'true');
      res.status(existing.result.statusCode).json(existing.result.body);
      return;
    }

    let settled = false;
    const release = (): void => {
      store.release(storeKey, token).catch((error: Error) =>
        logger.error({ event: 'idempotency_release_error', operation, error: error.message })
      );
    };

    // Store the original json method
    const originalJson = res.json.bind(res);

    // Override json to capture the response
    res.json = (body: unknown): Response => {
      if (!settled) {
        settled = true;
        if (res.statusCode >= 500) {
          // A server error may be transient: free the key so a retry runs again
          release();
        } else {
          const result: CachedResult = { statusCode: res.statusCode, body };
          store
            .complete(storeKey, { state: 'done', fingerprint, result })
            .catch((error: Error) =>
              logger.error({ event: 'idempotency_store_error', operation, error: error.message })
            );

          idempotencyMetrics.processed.inc({ operation });

          logger.debug({
            event: 'idempotency_stored',
            idempotencyKey: clientKey,
            operation,
            statusCode: res.statusCode,
          });
        }
      }

      return originalJson(body);
    };

    // A response sent without res.json (res.send, res.end) isn't stored; free the key
    res.once('finish', () => {
      if (!settled) {
        settled = true;
        release();
      }
    });

    next();
  };
}

/**
 * Redis-based idempotency handler for distributed deployments
 */
export class RedisIdempotencyHandler {
  private redis: Redis;
  private prefix: string;
  private expirySeconds: number;

  constructor(redis: Redis, options: IdempotencyHandlerOptions = {}) {
    this.redis = redis;
    this.prefix = options.prefix || 'idem';
    this.expirySeconds = options.expirySeconds || 300; // 5 minutes
  }

  /**
   * Check if operation was already processed
   */
  async check(idempotencyKey: string): Promise<{ result: unknown } | null> {
    try {
      const result = await this.redis.get(`${this.prefix}:${idempotencyKey}`);
      if (result) {
        return JSON.parse(result);
      }
    } catch (error) {
      logger.error({
        event: 'idempotency_check_error',
        idempotencyKey,
        error: (error as Error).message,
      });
    }
    return null;
  }

  /**
   * Store operation result
   */
  async store(idempotencyKey: string, operation: string, result: unknown): Promise<void> {
    try {
      await this.redis.setex(
        `${this.prefix}:${idempotencyKey}`,
        this.expirySeconds,
        JSON.stringify({
          operation,
          result,
          timestamp: Date.now(),
        })
      );

      logger.debug({
        event: 'idempotency_stored_redis',
        idempotencyKey,
        operation,
      });
    } catch (error) {
      logger.error({
        event: 'idempotency_store_error',
        idempotencyKey,
        error: (error as Error).message,
      });
    }
  }

  /**
   * Process operation with idempotency
   */
  async process<T>(
    idempotencyKey: string,
    operation: string,
    fn: () => Promise<T>
  ): Promise<ProcessResult<T>> {
    // Check if already processed
    const cached = await this.check(idempotencyKey);
    if (cached) {
      auditLogger.logIdempotencySkip(idempotencyKey, operation);
      idempotencyMetrics.duplicates.inc({ operation });

      return {
        processed: false,
        duplicate: true,
        result: cached.result as T,
      };
    }

    // Try to acquire lock using SETNX
    const lockKey = `${this.prefix}:lock:${idempotencyKey}`;
    const acquired = await this.redis.set(lockKey, '1', 'EX', 30, 'NX');

    if (!acquired) {
      // Another process is handling this
      logger.info({
        event: 'idempotency_lock_failed',
        idempotencyKey,
        operation,
      });

      // Wait and check for result
      await new Promise((r) => setTimeout(r, 100));
      const retryResult = await this.check(idempotencyKey);
      if (retryResult) {
        return {
          processed: false,
          duplicate: true,
          result: retryResult.result as T,
        };
      }

      // Still no result, let it proceed (edge case)
    }

    try {
      // Execute the operation
      const result = await fn();

      // Store result
      await this.store(idempotencyKey, operation, result);
      idempotencyMetrics.processed.inc({ operation });

      return {
        processed: true,
        duplicate: false,
        result,
      };
    } finally {
      // Release lock
      await this.redis.del(lockKey);
    }
  }
}

/**
 * Create idempotency handler from Redis client
 */
export function createRedisIdempotencyHandler(
  redis: Redis,
  options: IdempotencyHandlerOptions = {}
): RedisIdempotencyHandler {
  return new RedisIdempotencyHandler(redis, options);
}

/**
 * Cleanup function for graceful shutdown
 */
export function cleanup(): void {
  inMemoryStore.destroy();
}

export default {
  generateIdempotencyKey,
  idempotencyMiddleware,
  createRedisIdempotencyHandler,
  cleanup,
};
