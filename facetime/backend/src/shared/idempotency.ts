/**
 * Idempotency handling for call initiation.
 *
 * Prevents duplicate call creation from network retries or client bugs.
 * Uses Redis with TTL to track idempotency keys.
 *
 * WHY idempotency prevents duplicate call initiations:
 * - Network retries can cause the same request to arrive multiple times
 * - Mobile apps may retry on timeout before response arrives
 * - Race conditions in client code could send duplicate requests
 * - Without idempotency, each retry creates a new call (bad UX)
 *
 * Implementation:
 * - Client sends X-Idempotency-Key header (UUID)
 * - Server stores key -> callId mapping in Redis
 * - If key exists, return existing callId instead of creating new call
 * - Keys expire after 5 minutes (longer than reasonable retry window)
 */

import { getRedisClient } from '../services/redis.js';
import { idempotencyHits, idempotencyMisses } from './metrics.js';
import { logger } from './logger.js';
import { CACHE_TTL } from './cache.js';

/**
 * Result of checking idempotency key.
 */
export interface IdempotencyResult {
  /** Whether this is a duplicate request */
  isDuplicate: boolean;
  /** Existing call ID if duplicate */
  existingCallId?: string;
}

/**
 * Checks if an idempotency key has been seen before.
 * If seen, returns the existing call ID.
 *
 * @param idempotencyKey - The client-provided idempotency key
 * @returns Result indicating if duplicate and existing call ID
 */
export async function checkIdempotencyKey(
  idempotencyKey: string
): Promise<IdempotencyResult> {
  if (!idempotencyKey) {
    // No key provided, treat as new request
    return { isDuplicate: false };
  }

  try {
    const client = await getRedisClient();
    const existingCallId = await client.get(`idempotency:call:${idempotencyKey}`);

    if (existingCallId) {
      idempotencyHits.inc();
      logger.info(
        { idempotencyKey, existingCallId },
        'Idempotency key hit - returning existing call'
      );
      return { isDuplicate: true, existingCallId };
    }

    idempotencyMisses.inc();
    return { isDuplicate: false };
  } catch (error) {
    logger.error({ error, idempotencyKey }, 'Error checking idempotency key');
    // On error, treat as new request (fail open for availability)
    return { isDuplicate: false };
  }
}

/**
 * Stores an idempotency key -> call ID mapping.
 * Should be called immediately after creating a new call.
 *
 * @param idempotencyKey - The client-provided idempotency key
 * @param callId - The newly created call ID
 */
export async function storeIdempotencyKey(
  idempotencyKey: string,
  callId: string
): Promise<void> {
  if (!idempotencyKey) {
    return;
  }

  try {
    const client = await getRedisClient();
    await client.setEx(
      `idempotency:call:${idempotencyKey}`,
      CACHE_TTL.IDEMPOTENCY,
      callId
    );
    logger.debug(
      { idempotencyKey, callId },
      'Stored idempotency key for call'
    );
  } catch (error) {
    logger.error({ error, idempotencyKey, callId }, 'Error storing idempotency key');
    // Don't throw - idempotency is best-effort
  }
}

/**
 * Removes an idempotency key (for cleanup on failed call creation).
 *
 * @param idempotencyKey - The idempotency key to remove
 */
export async function removeIdempotencyKey(idempotencyKey: string): Promise<void> {
  if (!idempotencyKey) {
    return;
  }

  try {
    const client = await getRedisClient();
    await client.del(`idempotency:call:${idempotencyKey}`);
  } catch (error) {
    logger.error({ error, idempotencyKey }, 'Error removing idempotency key');
  }
}

/**
 * Generates a deterministic idempotency key for ICE candidates.
 * Used to deduplicate ICE candidate messages.
 *
 * @param callId - The call ID
 * @param deviceId - The sending device ID
 * @param candidateStr - The ICE candidate string
 * @returns A hash of the candidate for deduplication
 */
export function generateICECandidateHash(
  callId: string,
  deviceId: string,
  candidateStr: string
): string {
  // Simple hash using built-in crypto
  const crypto = require('crypto');
  return crypto
    .createHash('sha256')
    .update(`${callId}:${deviceId}:${candidateStr}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * Checks if an ICE candidate has already been processed.
 *
 * @param callId - The call ID
 * @param candidateHash - Hash of the ICE candidate
 * @returns True if this is a new candidate, false if duplicate
 */
export async function checkICECandidateDedup(
  callId: string,
  candidateHash: string
): Promise<boolean> {
  try {
    const client = await getRedisClient();
    const key = `ice:${callId}:${candidateHash}`;

    // SETNX returns true if key was set (new), false if exists (duplicate)
    const wasSet = await client.setNX(key, Date.now().toString());

    if (wasSet) {
      // Set TTL for cleanup
      await client.expire(key, 3600); // 1 hour
      return true; // New candidate
    }

    logger.debug({ callId, candidateHash }, 'Duplicate ICE candidate ignored');
    return false; // Duplicate
  } catch (error) {
    logger.error({ error, callId }, 'Error checking ICE candidate dedup');
    return true; // Fail open
  }
}
