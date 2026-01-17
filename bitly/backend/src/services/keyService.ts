import { query, withTransaction } from '../utils/database.js';
import { URL_CONFIG, SERVER_ID } from '../config.js';
import { KeyPoolEntry } from '../models/types.js';

// Local key cache for this server instance
let localKeyCache: string[] = [];

// Generate a random short code (for custom code validation backup)
function generateRandomCode(length: number = 7): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Fetch a batch of keys from the database and allocate to this server
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

// Ensure we have enough keys in local cache
async function ensureKeysAvailable(): Promise<void> {
  if (localKeyCache.length < URL_CONFIG.keyPoolMinThreshold) {
    const newKeys = await fetchKeyBatch();
    localKeyCache.push(...newKeys);
    console.log(`Fetched ${newKeys.length} keys, total in cache: ${localKeyCache.length}`);
  }
}

// Get a key from the local cache
export async function getNextKey(): Promise<string> {
  await ensureKeysAvailable();

  if (localKeyCache.length === 0) {
    // Fallback: generate a random key if pool is empty
    console.warn('Key pool empty, generating random key');
    return generateRandomCode(URL_CONFIG.shortCodeLength);
  }

  const key = localKeyCache.pop()!;
  return key;
}

// Mark a key as used in the database
export async function markKeyAsUsed(shortCode: string): Promise<void> {
  await query(
    `UPDATE key_pool SET is_used = true WHERE short_code = $1`,
    [shortCode]
  );
}

// Check if a custom code is available
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

// Get key pool statistics
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

// Repopulate key pool if running low
export async function repopulateKeyPool(count: number = 1000): Promise<number> {
  const result = await query<{ populate_key_pool: number }>(
    `SELECT populate_key_pool($1)`,
    [count]
  );
  return result[0].populate_key_pool;
}

// Initialize key service - fetch initial batch
export async function initKeyService(): Promise<void> {
  await ensureKeysAvailable();
  console.log(`Key service initialized with ${localKeyCache.length} keys`);
}

// Get local cache count
export function getLocalCacheCount(): number {
  return localKeyCache.length;
}
