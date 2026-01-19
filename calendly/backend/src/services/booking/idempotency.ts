/**
 * Idempotency handling helpers for booking operations.
 *
 * @description Provides idempotency support to prevent duplicate bookings from
 * network retries or duplicate submissions. Uses Redis-based distributed locking
 * and result caching to ensure exactly-once semantics for booking creation.
 *
 * This module is extracted from create.ts to keep that file under 200 lines.
 *
 * @module services/booking/idempotency
 */

import { type Booking, type CreateBookingResult } from './types.js';
import { idempotencyService, IdempotencyService } from '../../shared/idempotency.js';
import { logger } from '../../shared/logger.js';

const bookingLogger = logger.child({ module: 'booking-idempotency' });

/**
 * Checks if a booking request has already been processed (idempotent check).
 *
 * @description Looks up the idempotency cache to see if an identical booking
 * request was already processed. If a client-provided key is not supplied,
 * generates a deterministic key from the booking parameters.
 *
 * @param {string} meetingTypeId - UUID of the meeting type being booked
 * @param {string} startTime - ISO 8601 start time of the requested slot
 * @param {string} inviteeEmail - Email address of the invitee
 * @param {string} [providedKey] - Optional client-provided idempotency key
 * @returns {Promise<{cached: CreateBookingResult | null, effectiveKey: string}>}
 *   - cached: The cached booking result if found, null otherwise
 *   - effectiveKey: The idempotency key used (provided or generated)
 *
 * @example
 * const { cached, effectiveKey } = await checkBookingIdempotency(
 *   meetingTypeId,
 *   startTime,
 *   inviteeEmail,
 *   req.headers['idempotency-key']
 * );
 * if (cached) {
 *   return cached; // Return previously created booking
 * }
 */
export async function checkBookingIdempotency(
  meetingTypeId: string,
  startTime: string,
  inviteeEmail: string,
  providedKey?: string
): Promise<{ cached: CreateBookingResult | null; effectiveKey: string }> {
  const effectiveKey =
    providedKey ||
    IdempotencyService.generateBookingKey(meetingTypeId, startTime, inviteeEmail);

  const existingResult = await idempotencyService.checkIdempotency(effectiveKey);
  if (existingResult.found && existingResult.result) {
    bookingLogger.info('Returning cached booking result (idempotent)');
    return {
      cached: {
        booking: existingResult.result as Booking,
        cached: true,
      },
      effectiveKey,
    };
  }

  return { cached: null, effectiveKey };
}

/**
 * Attempts to acquire an idempotency lock for a booking request.
 *
 * @description Tries to acquire a distributed lock to ensure only one request
 * processes this booking. If the lock cannot be acquired, it waits briefly
 * and checks if another request has already completed the booking.
 *
 * This prevents duplicate bookings when multiple identical requests arrive
 * simultaneously (e.g., due to network retries or double-clicks).
 *
 * @param {string} effectiveKey - The idempotency key from checkBookingIdempotency
 * @returns {Promise<{lockAcquired: true} | {lockAcquired: false, cached: CreateBookingResult}>}
 *   - If lock acquired: {lockAcquired: true}
 *   - If another request finished: {lockAcquired: false, cached: result}
 * @throws {Error} "Request is being processed. Please wait and try again." if lock unavailable
 *   and no cached result exists after waiting
 *
 * @example
 * const lockResult = await acquireBookingLock(effectiveKey);
 * if (!lockResult.lockAcquired) {
 *   return lockResult.cached; // Another request completed the booking
 * }
 * // Proceed with booking creation...
 */
export async function acquireBookingLock(
  effectiveKey: string
): Promise<{ lockAcquired: true } | { lockAcquired: false; cached: CreateBookingResult }> {
  const lockAcquired = await idempotencyService.acquireLock(effectiveKey);

  if (!lockAcquired) {
    bookingLogger.warn('Could not acquire idempotency lock, another request is processing');
    // Wait briefly and check for result again
    await new Promise((resolve) => setTimeout(resolve, 100));
    const retryResult = await idempotencyService.checkIdempotency(effectiveKey);
    if (retryResult.found && retryResult.result) {
      return {
        lockAcquired: false,
        cached: {
          booking: retryResult.result as Booking,
          cached: true,
        },
      };
    }
    throw new Error('Request is being processed. Please wait and try again.');
  }

  return { lockAcquired: true };
}

/**
 * Stores the booking result for idempotency and releases the lock.
 *
 * @description Called after successful booking creation to cache the result.
 * Future requests with the same idempotency key will receive this cached result
 * instead of creating a duplicate booking.
 *
 * @param {string} effectiveKey - The idempotency key
 * @param {Booking} booking - The successfully created booking to cache
 * @returns {Promise<void>} Resolves when result is stored
 *
 * @example
 * await storeBookingResult(effectiveKey, newBooking);
 */
export async function storeBookingResult(
  effectiveKey: string,
  booking: Booking
): Promise<void> {
  await idempotencyService.storeResult(effectiveKey, booking, 201);
}

/**
 * Releases the idempotency lock.
 *
 * @description Called in the finally block of booking creation to ensure the
 * lock is released even if an error occurs. This allows subsequent requests
 * to proceed if the original request failed.
 *
 * @param {string} effectiveKey - The idempotency key to unlock
 * @returns {Promise<void>} Resolves when lock is released
 *
 * @example
 * try {
 *   // Create booking...
 * } finally {
 *   await releaseBookingLock(effectiveKey);
 * }
 */
export async function releaseBookingLock(effectiveKey: string): Promise<void> {
  await idempotencyService.releaseLock(effectiveKey);
}
