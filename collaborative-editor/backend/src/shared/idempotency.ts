/**
 * @fileoverview Idempotency handling for document operations.
 *
 * Ensures operations are applied exactly once, even with retries:
 * - Client sends operationId with each operation
 * - Server checks Redis cache before processing
 * - If already processed, returns cached result
 * - If new, processes and caches result
 *
 * This enables reliable OT even with network issues:
 * - Client can safely retry on timeout
 * - Duplicate operations are detected and skipped
 * - Cached results are returned for duplicates
 */

import { getRedisClient } from '../services/redis.js';
import { logger } from './logger.js';
import { duplicateOperationsCounter, getServerId } from './metrics.js';

/**
 * TTL for idempotency cache entries (1 hour).
 * After this time, duplicate detection won't work,
 * but by then the client should have received ack.
 */
const IDEMPOTENCY_TTL = 3600;

/**
 * Result of an idempotent operation check.
 */
export interface IdempotencyResult<T> {
  /** Whether this is a duplicate operation */
  duplicate: boolean;
  /** The cached result (if duplicate) */
  result?: T;
}

/**
 * Cached operation result structure.
 */
interface CachedResult<T> {
  version: number;
  result: T;
  processedAt: number;
}

/**
 * Check if an operation has already been processed.
 * If so, returns the cached result.
 *
 * @param operationId - The unique operation ID from the client
 * @returns Whether it's a duplicate and the cached result if so
 */
export async function checkIdempotency<T>(
  operationId: string
): Promise<IdempotencyResult<T>> {
  const redis = await getRedisClient();
  const key = `idempotent:${operationId}`;

  const cached = await redis.get(key);
  if (cached) {
    try {
      const parsed: CachedResult<T> = JSON.parse(cached);
      logger.debug({
        event: 'idempotent_hit',
        operation_id: operationId,
        cached_version: parsed.version,
        processed_at: parsed.processedAt,
      });
      duplicateOperationsCounter.inc({ server_id: getServerId() });
      return {
        duplicate: true,
        result: parsed.result,
      };
    } catch {
      // Invalid cache entry, treat as new
      await redis.del(key);
    }
  }

  return { duplicate: false };
}

/**
 * Store the result of a processed operation for idempotency.
 *
 * @param operationId - The unique operation ID
 * @param version - The resulting document version
 * @param result - The operation result to cache
 */
export async function storeIdempotencyResult<T>(
  operationId: string,
  version: number,
  result: T
): Promise<void> {
  const redis = await getRedisClient();
  const key = `idempotent:${operationId}`;

  const cached: CachedResult<T> = {
    version,
    result,
    processedAt: Date.now(),
  };

  await redis.setEx(key, IDEMPOTENCY_TTL, JSON.stringify(cached));

  logger.debug({
    event: 'idempotent_stored',
    operation_id: operationId,
    version,
  });
}

/**
 * Generate an operation ID for idempotency.
 * Called by clients to create unique operation identifiers.
 *
 * Format: {clientId}-{timestamp}-{hash}
 *
 * @param clientId - The client's session ID
 * @param operationContent - The operation content to hash
 * @returns A unique operation ID
 */
export function generateOperationId(
  clientId: string,
  operationContent: string
): string {
  const timestamp = Date.now();
  const hash = hashCode(operationContent);
  return `${clientId}-${timestamp}-${hash}`;
}

/**
 * Simple hash function for operation content.
 * Not cryptographic, just for deduplication.
 */
function hashCode(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(36);
}

/**
 * Wrapper for idempotent operation execution.
 * Checks cache, executes if new, caches result.
 *
 * @param operationId - The unique operation ID
 * @param execute - Function to execute if not duplicate
 * @returns The operation result (cached or fresh)
 */
export async function executeIdempotent<T>(
  operationId: string,
  execute: () => Promise<{ version: number; result: T }>
): Promise<{ duplicate: boolean; version: number; result: T }> {
  // Check for duplicate
  const check = await checkIdempotency<T>(operationId);
  if (check.duplicate && check.result !== undefined) {
    return {
      duplicate: true,
      version: 0, // Version is in the cached result
      result: check.result,
    };
  }

  // Execute the operation
  const { version, result } = await execute();

  // Cache the result
  await storeIdempotencyResult(operationId, version, result);

  return {
    duplicate: false,
    version,
    result,
  };
}
