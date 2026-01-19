import { query, withTransaction } from '../utils/database.js';
import { URL_CONFIG, SERVER_ID } from '../config.js';
import { KeyPoolEntry } from '../models/types.js';
import logger from '../utils/logger.js';

/**
 * Local key cache for this server instance.
 * Stores pre-allocated short codes to avoid database queries on every URL creation.
 */
let localKeyCache: string[] = [];

/**
 * Generates a random alphanumeric short code.
 * Used as a fallback when the key pool is exhausted.
 * @param length - Length of the code to generate (default: 7)
 * @returns Random alphanumeric string
 */
function generateRandomCode(length: number = 7): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Fetches a batch of unused keys from the database and allocates them to this server.
 * Uses row-level locking (FOR UPDATE SKIP LOCKED) to prevent race conditions
 * when multiple servers fetch keys simultaneously.
 * @returns Promise resolving to array of allocated short codes
 */
async function fetchKeyBatch(): Promise<string[]> {
  return withTransaction(async (client) => {
    // Select unused keys and mark them as allocated
    const result = await client.query(
      `UPDATE key_pool
       SET is_used = false, allocated_to = $1, allocated_at = NOW()
       WHERE short_code IN (
         SELECT short_code FROM key_pool
         WHERE is_used = false AND allocated_to IS NULL
         LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING short_code`,
      [SERVER_ID, URL_CONFIG.keyPoolBatchSize]
    );

    return result.rows.map((row: { short_code: string }) => row.short_code);
  });
}

/**
 * Ensures the local key cache has sufficient keys.
 * Triggers a batch fetch from the database when cache runs low.
 */
async function ensureKeysAvailable(): Promise<void> {
  if (localKeyCache.length < URL_CONFIG.keyPoolMinThreshold) {
    const newKeys = await fetchKeyBatch();
    localKeyCache.push(...newKeys);
    logger.info({ fetched: newKeys.length, total: localKeyCache.length }, 'Keys fetched into local cache');
  }
}

/**
 * Retrieves the next available short code for URL creation.
 * Draws from the local cache, fetching more from database if needed.
 * Falls back to random generation if the pool is exhausted.
 * @returns Promise resolving to a unique short code
 */
export async function getNextKey(): Promise<string> {
  await ensureKeysAvailable();

  if (localKeyCache.length === 0) {
    // Fallback: generate a random key if pool is empty
    logger.warn('Key pool empty, generating random key');
    return generateRandomCode(URL_CONFIG.shortCodeLength);
  }

  const key = localKeyCache.pop()!;
  return key;
}

/**
 * Marks a short code as used in the database after URL creation.
 * Prevents the key from being reallocated to another server.
 * @param shortCode - The short code that was used
 */
export async function markKeyAsUsed(shortCode: string): Promise<void> {
  await query(
    `UPDATE key_pool SET is_used = true WHERE short_code = $1`,
    [shortCode]
  );
}

/**
 * Checks if a custom short code is available for use.
 * Validates against reserved words and existing URLs/keys.
 * @param code - The custom code to check
 * @returns Promise resolving to true if available, false otherwise
 */
export async function isCodeAvailable(code: string): Promise<boolean> {
  // Check reserved words
  if (URL_CONFIG.reservedWords.includes(code.toLowerCase())) {
    return false;
  }

  // Check if already in use in urls table
  const existingUrls = await query<{ short_code: string }>(
    `SELECT short_code FROM urls WHERE short_code = $1`,
    [code]
  );

  if (existingUrls.length > 0) {
    return false;
  }

  // Check if in key pool (allocated but not yet used)
  const existingKeys = await query<{ short_code: string }>(
    `SELECT short_code FROM key_pool WHERE short_code = $1`,
    [code]
  );

  if (existingKeys.length > 0) {
    return false;
  }

  return true;
}

/**
 * Retrieves statistics about the key pool.
 * Used by the admin dashboard to monitor key availability.
 * @returns Promise resolving to key pool statistics
 */
export async function getKeyPoolStats(): Promise<{
  total: number;
  used: number;
  available: number;
  allocated: number;
}> {
  const result = await query<{
    total: string;
    used: string;
    available: string;
    allocated: string;
  }>(
    `SELECT
       COUNT(*) as total,
       COUNT(*) FILTER (WHERE is_used = true) as used,
       COUNT(*) FILTER (WHERE is_used = false AND allocated_to IS NULL) as available,
       COUNT(*) FILTER (WHERE is_used = false AND allocated_to IS NOT NULL) as allocated
     FROM key_pool`
  );

  return {
    total: parseInt(result[0].total, 10),
    used: parseInt(result[0].used, 10),
    available: parseInt(result[0].available, 10),
    allocated: parseInt(result[0].allocated, 10),
  };
}

/**
 * Adds new pre-generated keys to the pool.
 * Called by admins when available keys run low.
 * @param count - Number of new keys to generate (default: 1000)
 * @returns Promise resolving to the number of keys added
 */
export async function repopulateKeyPool(count: number = 1000): Promise<number> {
  const result = await query<{ populate_key_pool: number }>(
    `SELECT populate_key_pool($1)`,
    [count]
  );
  return result[0].populate_key_pool;
}

/**
 * Initializes the key service on server startup.
 * Fetches an initial batch of keys into the local cache.
 */
export async function initKeyService(): Promise<void> {
  await ensureKeysAvailable();
  logger.info({ keys: localKeyCache.length }, 'Key service initialized');
}

/**
 * Returns the number of keys in the local cache.
 * Useful for monitoring and debugging.
 * @returns Number of available keys in local cache
 */
export function getLocalCacheCount(): number {
  return localKeyCache.length;
}
