/**
 * Idempotency service for preventing duplicate operations.
 * Uses database-backed idempotency keys for order placement and other critical operations.
 *
 * WHY idempotency:
 * - Prevents duplicate orders when clients retry on network timeout
 * - Prevents double charges if payment succeeds but response is lost
 * - Enables safe retries without side effects
 * - Maintains exactly-once semantics for critical operations
 *
 * Implementation:
 * 1. Client generates unique idempotency key (UUID v4)
 * 2. Server checks if key exists in idempotency_keys table
 * 3. If exists, return cached response (no duplicate operation)
 * 4. If not, execute operation and store response with key
 * 5. Keys expire after 24 hours via cleanup job
 *
 * @module shared/idempotency
 */
import { queryOne, execute, pool } from '../utils/db.js';
import { orderLogger } from './logger.js';

/**
 * Idempotency key record in the database.
 */
export interface IdempotencyKey {
  key: string;
  user_id: string;
  operation: string;
  response: unknown;
  status: 'pending' | 'completed' | 'failed';
  created_at: Date;
  expires_at: Date;
}

/**
 * Result of an idempotency check.
 */
export interface IdempotencyResult<T> {
  /** Whether the operation was executed (true) or cached response returned (false) */
  executed: boolean;
  /** The response from the operation or cache */
  response: T;
}

/**
 * Idempotency key TTL in hours.
 */
const IDEMPOTENCY_KEY_TTL_HOURS = 24;

/**
 * Executes an operation with idempotency protection.
 * If the key was used before, returns the cached response.
 * Otherwise, executes the operation and caches the result.
 *
 * @param key - Unique idempotency key from client
 * @param userId - User ID for the operation
 * @param operation - Operation type (e.g., 'create_order')
 * @param fn - The operation to execute
 * @returns The operation result (from cache or fresh execution)
 *
 * @example
 * const result = await withIdempotency(
 *   req.headers['x-idempotency-key'],
 *   userId,
 *   'create_order',
 *   async () => createOrder(userId, orderData)
 * );
 */
export async function withIdempotency<T>(
  key: string | undefined,
  userId: string,
  operation: string,
  fn: () => Promise<T>
): Promise<IdempotencyResult<T>> {
  // If no key provided, execute without idempotency
  if (!key) {
    orderLogger.debug({ operation }, 'No idempotency key provided, executing directly');
    const response = await fn();
    return { executed: true, response };
  }

  // Validate key format (should be UUID-like)
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(key)) {
    throw new Error('Invalid idempotency key format');
  }

  // Check for existing key
  const existing = await getIdempotencyKey(key);

  if (existing) {
    // Key exists - check status
    if (existing.status === 'pending') {
      // Another request is in progress with the same key
      // This could indicate a race condition
      orderLogger.warn({ key, operation }, 'Idempotency key in pending state (concurrent request)');
      throw new Error('Request already in progress');
    }

    if (existing.status === 'completed') {
      // Return cached response
      orderLogger.info({ key, operation }, 'Returning cached response for idempotency key');
      return { executed: false, response: existing.response as T };
    }

    if (existing.status === 'failed') {
      // Previous attempt failed - allow retry
      orderLogger.info({ key, operation }, 'Previous attempt failed, allowing retry');
      // Delete the failed key and proceed
      await deleteIdempotencyKey(key);
    }
  }

  // Create pending idempotency key
  try {
    await createIdempotencyKey(key, userId, operation);
  } catch (error) {
    // If we fail to create (duplicate key), another request got there first
    orderLogger.warn({ key, operation, error: (error as Error).message }, 'Failed to create idempotency key');
    throw new Error('Duplicate request detected');
  }

  try {
    // Execute the operation
    const response = await fn();

    // Mark as completed with response
    await completeIdempotencyKey(key, response);

    orderLogger.info({ key, operation }, 'Operation completed with idempotency key');
    return { executed: true, response };
  } catch (error) {
    // Mark as failed
    await failIdempotencyKey(key, (error as Error).message);
    throw error;
  }
}

/**
 * Gets an existing idempotency key record.
 *
 * @param key - The idempotency key
 * @returns The key record or null if not found
 */
export async function getIdempotencyKey(key: string): Promise<IdempotencyKey | null> {
  return queryOne<IdempotencyKey>(
    `SELECT * FROM idempotency_keys WHERE key = $1 AND expires_at > NOW()`,
    [key]
  );
}

/**
 * Creates a new idempotency key in pending state.
 *
 * @param key - The idempotency key
 * @param userId - User ID for the operation
 * @param operation - Operation type
 */
async function createIdempotencyKey(
  key: string,
  userId: string,
  operation: string
): Promise<void> {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + IDEMPOTENCY_KEY_TTL_HOURS);

  await pool.query(
    `INSERT INTO idempotency_keys (key, user_id, operation, status, expires_at)
     VALUES ($1, $2, $3, 'pending', $4)`,
    [key, userId, operation, expiresAt]
  );
}

/**
 * Marks an idempotency key as completed with the response.
 *
 * @param key - The idempotency key
 * @param response - The operation response to cache
 */
async function completeIdempotencyKey(key: string, response: unknown): Promise<void> {
  await execute(
    `UPDATE idempotency_keys
     SET status = 'completed', response = $1
     WHERE key = $2`,
    [JSON.stringify(response), key]
  );
}

/**
 * Marks an idempotency key as failed.
 *
 * @param key - The idempotency key
 * @param errorMessage - The error message
 */
async function failIdempotencyKey(key: string, errorMessage: string): Promise<void> {
  await execute(
    `UPDATE idempotency_keys
     SET status = 'failed', response = $1
     WHERE key = $2`,
    [JSON.stringify({ error: errorMessage }), key]
  );
}

/**
 * Deletes an idempotency key.
 *
 * @param key - The idempotency key to delete
 */
async function deleteIdempotencyKey(key: string): Promise<void> {
  await execute(`DELETE FROM idempotency_keys WHERE key = $1`, [key]);
}

/**
 * Cleans up expired idempotency keys.
 * Should be called periodically (e.g., hourly via cron).
 *
 * @returns Number of keys deleted
 */
export async function cleanupExpiredIdempotencyKeys(): Promise<number> {
  const result = await execute(`DELETE FROM idempotency_keys WHERE expires_at < NOW()`);
  if (result > 0) {
    orderLogger.info({ count: result }, 'Cleaned up expired idempotency keys');
  }
  return result;
}

export default {
  withIdempotency,
  getIdempotencyKey,
  cleanupExpiredIdempotencyKeys,
};
