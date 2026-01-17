import crypto from 'crypto';
import redis from '../db/redis.js';
import { createComponentLogger } from './logger.js';
import { idempotencyDedupes } from './metrics.js';

/**
 * Idempotency layer for preventing duplicate location report processing.
 *
 * WHY IDEMPOTENCY IS CRITICAL:
 * - Network retries: Mobile clients may retry failed requests
 * - At-least-once delivery: Message queues may redeliver messages
 * - User double-clicks: UI may trigger multiple submissions
 * - Crash recovery: Clients may not know if request succeeded
 *
 * IMPLEMENTATION APPROACH:
 * - Generate deterministic idempotency key from request content
 * - Store key in Redis with short TTL (24 hours)
 * - Reject requests with existing keys (return success, but don't process)
 *
 * WHY REDIS FOR IDEMPOTENCY:
 * - Fast O(1) key existence check
 * - Automatic TTL-based cleanup (no background jobs needed)
 * - Atomic SETNX operation prevents race conditions
 * - Distributed: works across multiple server instances
 *
 * SEMANTICS:
 * - Eventual consistency: Duplicate detected within TTL window
 * - Idempotent key = hash of (identifier + timestamp + payload hash)
 * - Response: Same as first request (200 OK, but with "deduplicated" flag)
 */

const log = createComponentLogger('idempotency');

// TTL for idempotency keys (24 hours covers most retry scenarios)
const IDEMPOTENCY_TTL = 24 * 60 * 60; // seconds

// Prefix for idempotency keys
const IDEMPOTENCY_PREFIX = 'findmy:idempotency';

/**
 * Result of an idempotency check.
 */
export interface IdempotencyResult {
  /** True if this is a duplicate request */
  isDuplicate: boolean;
  /** The idempotency key that was checked/stored */
  idempotencyKey: string;
  /** Previous response if duplicate (for replay) */
  previousResponse?: unknown;
}

/**
 * Generate a deterministic idempotency key for a location report.
 *
 * The key is a hash of:
 * - identifier_hash: The device's current identifier
 * - timestamp: Rounded to nearest minute to handle clock drift
 * - payload_hash: Hash of encrypted payload content
 *
 * This ensures the same logical report generates the same key,
 * even if retried by different server instances.
 *
 * @param identifierHash - The identifier hash from the report
 * @param timestamp - Report timestamp (will be rounded to nearest minute)
 * @param encryptedPayload - The encrypted location payload
 * @returns A 32-character hex idempotency key
 */
export function generateIdempotencyKey(
  identifierHash: string,
  timestamp: number,
  encryptedPayload: unknown
): string {
  // Round timestamp to nearest minute to handle clock drift (+/- 30 seconds)
  const roundedTimestamp = Math.floor(timestamp / 60000) * 60000;

  // Create a hash of the payload to catch identical content
  const payloadHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(encryptedPayload))
    .digest('hex')
    .slice(0, 16);

  // Combine all components into a single idempotency key
  const combined = `${identifierHash}:${roundedTimestamp}:${payloadHash}`;

  return crypto
    .createHash('sha256')
    .update(combined)
    .digest('hex')
    .slice(0, 32);
}

/**
 * Check if a request is a duplicate using atomic Redis SETNX.
 *
 * Uses Redis SETNX (SET if Not eXists) for atomic check-and-set:
 * - If key doesn't exist: Set it with TTL, return isDuplicate=false
 * - If key exists: Return isDuplicate=true with previous response
 *
 * @param idempotencyKey - The idempotency key to check
 * @param response - The response to store if this is a new request
 * @returns IdempotencyResult indicating if this is a duplicate
 */
export async function checkIdempotency(
  idempotencyKey: string,
  response?: unknown
): Promise<IdempotencyResult> {
  const key = `${IDEMPOTENCY_PREFIX}:${idempotencyKey}`;

  try {
    // Use SET with NX (only set if not exists) and EX (TTL)
    const result = await redis.set(
      key,
      JSON.stringify({ timestamp: Date.now(), response }),
      'EX',
      IDEMPOTENCY_TTL,
      'NX'
    );

    if (result === 'OK') {
      // New request, key was set
      log.debug({ idempotencyKey }, 'New request, idempotency key stored');
      return { isDuplicate: false, idempotencyKey };
    }

    // Duplicate request, key already exists
    log.info({ idempotencyKey }, 'Duplicate request detected');
    idempotencyDedupes.inc({ endpoint: 'location_report' });

    // Retrieve previous response for replay
    const existing = await redis.get(key);
    let previousResponse: unknown = undefined;

    if (existing) {
      try {
        const parsed = JSON.parse(existing);
        previousResponse = parsed.response;
      } catch {
        // Ignore parse errors
      }
    }

    return {
      isDuplicate: true,
      idempotencyKey,
      previousResponse,
    };
  } catch (error) {
    // On Redis error, fail open (allow the request)
    // This prevents Redis issues from blocking all writes
    log.error({ error, idempotencyKey }, 'Idempotency check failed, allowing request');
    return { isDuplicate: false, idempotencyKey };
  }
}

/**
 * Mark a request as processed after successful completion.
 * Updates the stored response for potential replay.
 *
 * @param idempotencyKey - The idempotency key
 * @param response - The final response to store
 */
export async function markProcessed(
  idempotencyKey: string,
  response: unknown
): Promise<void> {
  const key = `${IDEMPOTENCY_PREFIX}:${idempotencyKey}`;

  try {
    await redis.setex(
      key,
      IDEMPOTENCY_TTL,
      JSON.stringify({ timestamp: Date.now(), response, processed: true })
    );
    log.debug({ idempotencyKey }, 'Request marked as processed');
  } catch (error) {
    log.error({ error, idempotencyKey }, 'Failed to mark request as processed');
  }
}

/**
 * Validate request timestamp to prevent replay attacks.
 *
 * Rejects requests that are:
 * - Too old: More than 7 days in the past (stale data)
 * - Too far in future: More than 5 minutes ahead (clock manipulation)
 *
 * @param timestamp - Request timestamp in milliseconds
 * @returns True if timestamp is valid, false otherwise
 */
export function validateTimestamp(timestamp: number): boolean {
  const now = Date.now();
  const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days
  const maxFuture = 5 * 60 * 1000; // 5 minutes

  if (timestamp < now - maxAge) {
    log.warn({ timestamp, age: now - timestamp }, 'Rejecting stale request');
    return false;
  }

  if (timestamp > now + maxFuture) {
    log.warn({ timestamp, drift: timestamp - now }, 'Rejecting future-dated request');
    return false;
  }

  return true;
}

/**
 * Express middleware for idempotent request handling.
 * Extracts idempotency key from headers or generates from body.
 */
export function idempotencyMiddleware(keyGenerator: (body: unknown) => string) {
  return async (
    req: { body: unknown; headers: Record<string, string | undefined>; idempotencyKey?: string; isDuplicate?: boolean },
    res: { json: (body: unknown) => void; status: (code: number) => { json: (body: unknown) => void } },
    next: () => void
  ) => {
    // Check for client-provided idempotency key in header
    let idempotencyKey = req.headers['x-idempotency-key'] || req.headers['idempotency-key'];

    // If no header, generate from request body
    if (!idempotencyKey && req.body) {
      idempotencyKey = keyGenerator(req.body);
    }

    if (!idempotencyKey) {
      // No idempotency key available, proceed normally
      next();
      return;
    }

    // Check for duplicate
    const result = await checkIdempotency(idempotencyKey);

    if (result.isDuplicate) {
      // Return cached response with 200 OK (idempotent behavior)
      log.info({ idempotencyKey }, 'Returning cached response for duplicate request');
      res.json({
        ...((result.previousResponse as object) || {}),
        _deduplicated: true,
      });
      return;
    }

    // Attach key to request for later marking as processed
    req.idempotencyKey = idempotencyKey;
    req.isDuplicate = false;
    next();
  };
}

export { IDEMPOTENCY_TTL, IDEMPOTENCY_PREFIX };
