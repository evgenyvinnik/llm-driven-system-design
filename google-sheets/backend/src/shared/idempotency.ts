/**
 * Idempotency handling for cell update operations.
 * Ensures that duplicate requests (e.g., from network retries) produce
 * the same result without unintended side effects.
 *
 * WHY: Network issues can cause clients to retry requests. Without
 * idempotency, the same cell edit might be applied multiple times,
 * leading to incorrect data or race conditions. By storing completed
 * operations with their results, we can safely replay duplicate requests.
 *
 * Implementation:
 * - Client generates a unique idempotency key per operation
 * - Server checks Redis for existing result before processing
 * - Results are cached for 24 hours to handle delayed retries
 * - Cell edits are naturally idempotent (last-write-wins), but this
 *   ensures consistent responses and avoids duplicate database writes
 *
 * @module shared/idempotency
 */

import { redis } from './redis.js';
import logger from './logger.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';

/** TTL for idempotency keys in seconds (24 hours) */
const IDEMPOTENCY_TTL = 86400;

/** Key prefix for idempotency entries */
const KEY_PREFIX = 'idempotent';

/**
 * Result of an idempotent operation check
 */
export interface IdempotencyResult<T> {
  /** Whether this is a replay of a previous request */
  isReplay: boolean;
  /** The cached result if this is a replay, undefined otherwise */
  cachedResult?: T;
}

/**
 * Represents a stored idempotent operation result
 */
interface StoredResult<T> {
  /** The result of the operation */
  result: T;
  /** Timestamp when the operation was processed */
  processedAt: number;
  /** The operation type for debugging */
  operation: string;
}

/**
 * Checks if an operation with the given idempotency key has already been processed.
 * If so, returns the cached result to ensure consistent responses.
 *
 * @example
 * const check = await checkIdempotency<CellUpdateResult>(idempotencyKey);
 * if (check.isReplay) {
 *   return check.cachedResult;
 * }
 * // Process the request...
 * await storeIdempotencyResult(idempotencyKey, 'cell_update', result);
 *
 * @param idempotencyKey - Client-generated unique key for this operation
 * @returns Object indicating if this is a replay and the cached result if so
 */
export async function checkIdempotency<T>(
  idempotencyKey: string
): Promise<IdempotencyResult<T>> {
  const key = `${KEY_PREFIX}:${idempotencyKey}`;

  try {
    const cached = await redis.get(key);

    if (cached) {
      idempotencyHits.inc();
      const stored: StoredResult<T> = JSON.parse(cached);
      logger.debug(
        { idempotencyKey, operation: stored.operation, processedAt: stored.processedAt },
        'Idempotent request replayed'
      );
      return {
        isReplay: true,
        cachedResult: stored.result,
      };
    }

    idempotencyMisses.inc();
    return { isReplay: false };
  } catch (error) {
    logger.error({ error, idempotencyKey }, 'Error checking idempotency key');
    // On error, proceed with processing (fail open)
    return { isReplay: false };
  }
}

/**
 * Stores the result of an idempotent operation for future replay.
 * Call this after successfully processing an operation.
 *
 * @param idempotencyKey - The same key used in checkIdempotency
 * @param operation - The operation type (for debugging/logging)
 * @param result - The result to cache for replays
 * @param ttl - Time-to-live in seconds (default: 24 hours)
 */
export async function storeIdempotencyResult<T>(
  idempotencyKey: string,
  operation: string,
  result: T,
  ttl: number = IDEMPOTENCY_TTL
): Promise<void> {
  const key = `${KEY_PREFIX}:${idempotencyKey}`;

  try {
    const stored: StoredResult<T> = {
      result,
      processedAt: Date.now(),
      operation,
    };

    await redis.setex(key, ttl, JSON.stringify(stored));
    logger.debug({ idempotencyKey, operation, ttl }, 'Idempotency result stored');
  } catch (error) {
    logger.error({ error, idempotencyKey, operation }, 'Error storing idempotency result');
    // Non-fatal: the operation still succeeded, just won't be cached
  }
}

/**
 * Executes an operation with idempotency guarantees.
 * Combines check and store into a single convenient function.
 *
 * @example
 * const result = await executeIdempotent(
 *   idempotencyKey,
 *   'cell_update',
 *   async () => {
 *     // Perform the actual operation
 *     await db.updateCell(sheetId, row, col, value);
 *     return { success: true, row, col, value };
 *   }
 * );
 *
 * @param idempotencyKey - Client-generated unique key for this operation
 * @param operation - The operation type (for debugging/logging)
 * @param action - The async function to execute if not a replay
 * @returns The result (either cached or freshly computed)
 */
export async function executeIdempotent<T>(
  idempotencyKey: string,
  operation: string,
  action: () => Promise<T>
): Promise<T> {
  // Check for existing result
  const check = await checkIdempotency<T>(idempotencyKey);
  if (check.isReplay && check.cachedResult !== undefined) {
    return check.cachedResult;
  }

  // Execute the operation
  const result = await action();

  // Store the result for future replays
  await storeIdempotencyResult(idempotencyKey, operation, result);

  return result;
}

/**
 * Generates an idempotency key for cell operations.
 * Combines spreadsheet, sheet, cell coordinates, and a client-provided request ID.
 *
 * @param spreadsheetId - The spreadsheet UUID
 * @param sheetId - The sheet UUID
 * @param row - The row index
 * @param col - The column index
 * @param requestId - Client-generated unique request ID
 * @returns A composite idempotency key
 */
export function generateCellIdempotencyKey(
  spreadsheetId: string,
  sheetId: string,
  row: number,
  col: number,
  requestId: string
): string {
  return `cell:${spreadsheetId}:${sheetId}:${row}:${col}:${requestId}`;
}

/**
 * Middleware-style function for Express routes.
 * Checks idempotency header and handles replays automatically.
 *
 * @param req - Express request with optional X-Idempotency-Key header
 * @returns The idempotency key if present, or undefined
 */
export function getIdempotencyKeyFromRequest(req: { headers: Record<string, string | undefined> }): string | undefined {
  return req.headers['x-idempotency-key'];
}

/**
 * Validates that an idempotency key is well-formed.
 * Keys should be UUIDs or similarly unique strings.
 *
 * @param key - The idempotency key to validate
 * @returns True if the key is valid
 */
export function isValidIdempotencyKey(key: string): boolean {
  // Allow UUIDs and other reasonable key formats
  // Min 8 chars, max 128 chars, alphanumeric with dashes and underscores
  return /^[a-zA-Z0-9_-]{8,128}$/.test(key);
}

export default {
  checkIdempotency,
  storeIdempotencyResult,
  executeIdempotent,
  generateCellIdempotencyKey,
  getIdempotencyKeyFromRequest,
  isValidIdempotencyKey,
};
