import crypto from 'crypto';
import type { PoolClient } from 'pg';
import { query, withTransaction } from '../utils/database.js';
import { URL_CONFIG, SERVER_ID } from '../config.js';
import logger from '../utils/logger.js';
import { keyPoolReclaimedTotal } from '../utils/metrics.js';

/**
 * A pool key held by this instance, stamped with the time its batch was leased.
 * The stamp is taken *before* the lease query runs, so local age is never smaller than
 * the age PostgreSQL computes from allocated_at. Only elapsed time on one clock is
 * compared, so clock offset between the app and the database does not matter.
 */
interface LeasedKey {
  code: string;
  leasedAt: number;
}

/**
 * Local key cache for this server instance, oldest lease first.
 * Stores pre-allocated short codes to avoid database queries on every URL creation.
 */
const localKeyCache: LeasedKey[] = [];

/** Batch fetch in flight; concurrent callers share it instead of leasing extra batches. */
let refillInFlight: Promise<void> | null = null;

/** Periodic stale-lease reaper. */
let reclaimTimer: NodeJS.Timeout | null = null;
let reclaimRunning = false;

const BASE62 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/**
 * Generates a random base62 short code using a CSPRNG.
 * Used as a fallback when the key pool is exhausted. Uniqueness is still enforced by the
 * urls primary key: createUrl retries with a fresh code on a unique violation.
 * @param length - Length of the code to generate (default: 7)
 * @returns Random alphanumeric string
 */
export function generateRandomCode(length: number = URL_CONFIG.shortCodeLength): string {
  let result = '';
  for (let i = 0; i < length; i++) {
    result += BASE62[crypto.randomInt(BASE62.length)];
  }
  return result;
}

/**
 * Whether a key leased at `leasedAt` may still be handed out at `now`.
 * Keys retire `safetyMarginMs` before the lease TTL, so a request that pauses between
 * this check and its INSERT still finishes well inside the lease. (If it pauses for longer
 * than the margin, the urls primary key plus createUrl's retry still prevent a duplicate.)
 * @param leasedAt - Epoch ms when the batch lease began
 * @param now - Current epoch ms
 * @param leaseTtlMs - Lease length after which the reaper may reclaim the key
 * @param safetyMarginMs - How early to retire keys before the lease ends
 */
export function isLeaseUsable(
  leasedAt: number,
  now: number,
  leaseTtlMs: number = URL_CONFIG.keyLeaseTtlMs,
  safetyMarginMs: number = URL_CONFIG.keyLeaseSafetyMarginMs
): boolean {
  return now - leasedAt < leaseTtlMs - safetyMarginMs;
}

/**
 * Drops local keys whose lease is too old to use safely. They stay allocated in
 * PostgreSQL until the reaper releases them once the full lease TTL has passed.
 * @param now - Current epoch ms
 * @returns Number of keys discarded
 */
function pruneExpiredLocalKeys(now: number = Date.now()): number {
  const usable = localKeyCache.filter((key) => isLeaseUsable(key.leasedAt, now));
  const discarded = localKeyCache.length - usable.length;
  if (discarded > 0) {
    localKeyCache.splice(0, localKeyCache.length, ...usable);
    logger.warn({ discarded }, 'Discarded local keys whose lease is about to expire');
  }
  return discarded;
}

/**
 * Fetches a batch of unused keys from the database and allocates them to this server.
 * Uses row-level locking (FOR UPDATE SKIP LOCKED) to prevent race conditions
 * when multiple servers fetch keys simultaneously.
 * @returns Promise resolving to the leased keys
 */
async function fetchKeyBatch(): Promise<LeasedKey[]> {
  const leasedAt = Date.now();
  const codes = await withTransaction(async (client) => {
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

  return codes.map((code) => ({ code, leasedAt }));
}

/**
 * Starts a batch fetch, or joins the one already running.
 * @returns Promise that settles when the shared fetch finishes
 */
function refill(): Promise<void> {
  if (!refillInFlight) {
    refillInFlight = fetchKeyBatch()
      .then((batch) => {
        localKeyCache.push(...batch);
        logger.info({ fetched: batch.length, total: localKeyCache.length }, 'Keys fetched into local cache');
      })
      .finally(() => {
        refillInFlight = null;
      });
  }
  return refillInFlight;
}

/**
 * Ensures the local key cache has sufficient keys.
 * Below the threshold a refill starts; the caller only waits for it when the cache is
 * empty, otherwise the refill runs in the background off the request path.
 */
async function ensureKeysAvailable(): Promise<void> {
  pruneExpiredLocalKeys();
  if (localKeyCache.length >= URL_CONFIG.keyPoolMinThreshold) {
    return;
  }

  const pending = refill();
  if (localKeyCache.length > 0) {
    pending.catch((error) => {
      logger.error({ err: error }, 'Background key refill failed');
    });
    return;
  }

  await pending;
}

/**
 * Retrieves the next available short code for URL creation.
 * Draws from the local cache (oldest lease first), fetching more from database if needed.
 * Falls back to random generation if the pool is exhausted.
 * @returns Promise resolving to a candidate short code (uniqueness is enforced at insert)
 */
export async function getNextKey(): Promise<string> {
  await ensureKeysAvailable();

  const key = localKeyCache.shift();
  if (!key) {
    // Fallback: generate a random key if pool is empty
    logger.warn('Key pool empty, generating random key');
    return generateRandomCode(URL_CONFIG.shortCodeLength);
  }

  return key.code;
}

/**
 * Marks a short code as used so it is never allocated again.
 * Pass the transaction client to make this atomic with the urls INSERT.
 * @param shortCode - The short code that was used
 * @param client - Optional transaction client
 */
export async function markKeyAsUsed(shortCode: string, client?: PoolClient): Promise<void> {
  const sql = `UPDATE key_pool SET is_used = true WHERE short_code = $1`;
  if (client) {
    await client.query(sql, [shortCode]);
    return;
  }
  await query(sql, [shortCode]);
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
 * Repairs the key pool after crashes and restarts.
 * (a) Unused pool rows whose code already exists in urls (custom codes, random
 *     fallbacks, rows whose mark-used never ran) are marked used so they are never leased.
 * (b) Leases older than the lease TTL that were never used are released back to the
 *     pool. Their holder retired them locally `keyLeaseSafetyMarginMs` earlier, so a live
 *     process will not use them after this point.
 * Safe to run concurrently from several instances.
 * @param leaseTtlMs - Lease length after which unused keys are reclaimed
 * @returns Counts of rows marked used and leases released
 */
export async function reclaimStaleKeys(
  leaseTtlMs: number = URL_CONFIG.keyLeaseTtlMs
): Promise<{ markedUsed: number; released: number }> {
  const markedResult = await query<{ count: string }>(
    `WITH marked AS (
       UPDATE key_pool k SET is_used = true
       FROM urls u
       WHERE u.short_code = k.short_code AND k.is_used = false
       RETURNING 1
     )
     SELECT COUNT(*) AS count FROM marked`
  );

  const releasedResult = await query<{ count: string }>(
    `WITH released AS (
       UPDATE key_pool k
       SET allocated_to = NULL, allocated_at = NULL
       WHERE k.is_used = false
         AND k.allocated_to IS NOT NULL
         AND (k.allocated_at IS NULL OR k.allocated_at < NOW() - make_interval(secs => $1::double precision))
         AND NOT EXISTS (SELECT 1 FROM urls u WHERE u.short_code = k.short_code)
       RETURNING 1
     )
     SELECT COUNT(*) AS count FROM released`,
    [leaseTtlMs / 1000]
  );

  const markedUsed = parseInt(markedResult[0].count, 10);
  const released = parseInt(releasedResult[0].count, 10);

  if (markedUsed > 0) keyPoolReclaimedTotal.inc({ action: 'marked_used' }, markedUsed);
  if (released > 0) keyPoolReclaimedTotal.inc({ action: 'released' }, released);
  if (markedUsed > 0 || released > 0) {
    logger.info({ marked_used: markedUsed, released }, 'Key pool reclaim completed');
  }

  return { markedUsed, released };
}

/**
 * Runs the reaper every `intervalMs` until stopped. The timer is unref'd so it never
 * keeps the process alive on its own; overlapping runs are skipped.
 * @param intervalMs - Interval between runs
 */
export function startKeyReclaimer(intervalMs: number = URL_CONFIG.keyReclaimIntervalMs): void {
  if (reclaimTimer) {
    return;
  }
  reclaimTimer = setInterval(() => {
    if (reclaimRunning) {
      return;
    }
    reclaimRunning = true;
    reclaimStaleKeys()
      .catch((error) => logger.error({ err: error }, 'Key pool reclaim failed'))
      .finally(() => {
        reclaimRunning = false;
      });
  }, intervalMs);
  reclaimTimer.unref();
}

/**
 * Stops the periodic reaper (graceful shutdown).
 */
export function stopKeyReclaimer(): void {
  if (reclaimTimer) {
    clearInterval(reclaimTimer);
    reclaimTimer = null;
  }
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
