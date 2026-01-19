/**
 * Driver matching module.
 * Handles driver matching logic with circuit breaker protection.
 *
 * @module services/order/matching
 * @description Implements the driver matching algorithm that sequentially offers
 * orders to nearby drivers. Includes circuit breaker protection to handle service
 * degradation gracefully and avoid cascading failures.
 */
import { queryOne, execute } from '../../utils/db.js';
import { findBestDriver } from '../driverService.js';
import { createCircuitBreaker } from '../../shared/circuitBreaker.js';
import { matchingLogger } from '../../shared/logger.js';
import {
  driverAssignmentsCounter,
  driverMatchingDurationHistogram,
} from '../../shared/metrics.js';
import { getOrderWithDetails } from './tracking.js';
import { updateOrderStatus } from './status.js';
import { createDriverOffer } from './assignment.js';
import type { DriverOffer, Location } from './types.js';
import {
  OFFER_EXPIRY_SECONDS,
  MAX_OFFER_ATTEMPTS,
  DRIVER_MATCHING_TIMEOUT_MS,
  CIRCUIT_BREAKER_ERROR_THRESHOLD,
  CIRCUIT_BREAKER_VOLUME_THRESHOLD,
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
} from './types.js';

/**
 * Waits for a driver to respond to an offer.
 *
 * @description Polls the database for offer status changes until the driver
 * accepts, rejects, or the timeout is reached. If timeout occurs, marks the
 * offer as expired.
 * @param {string} offerId - The offer's UUID
 * @param {number} timeoutMs - Maximum time to wait in milliseconds
 * @returns {Promise<'accepted' | 'rejected' | 'expired'>} The final offer status
 * @private
 */
async function waitForOfferResponse(
  offerId: string,
  timeoutMs: number
): Promise<'accepted' | 'rejected' | 'expired'> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const offer = await queryOne<DriverOffer>(
      `SELECT status FROM driver_offers WHERE id = $1`,
      [offerId]
    );

    if (offer?.status === 'accepted') return 'accepted';
    if (offer?.status === 'rejected') return 'rejected';

    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  await execute(
    `UPDATE driver_offers SET status = 'expired' WHERE id = $1 AND status = 'pending'`,
    [offerId]
  );

  return 'expired';
}

/**
 * Initiates driver matching for a new order.
 *
 * @description Implements a sequential offer algorithm:
 * 1. Finds the best available driver near the merchant location
 * 2. Creates a time-limited offer for that driver
 * 3. Waits for driver response (accept/reject/timeout)
 * 4. On rejection/timeout, repeats with next best driver
 * 5. Cancels order if MAX_OFFER_ATTEMPTS is exhausted
 *
 * Drivers are scored based on proximity, rating, and availability.
 * Each offer expires after OFFER_EXPIRY_SECONDS (30s default).
 * @param {string} orderId - The order's UUID to find a driver for
 * @returns {Promise<boolean>} True if driver was successfully assigned, false if no driver accepted
 * @example
 * const matched = await startDriverMatching(orderId);
 * if (matched) {
 *   console.log('Driver assigned successfully');
 * } else {
 *   console.log('Order cancelled - no drivers available');
 * }
 */
export async function startDriverMatching(orderId: string): Promise<boolean> {
  const order = await getOrderWithDetails(orderId);
  if (!order || !order.merchant) return false;

  const merchantLocation: Location = {
    lat: order.merchant.lat,
    lng: order.merchant.lng,
  };

  const excludedDrivers = new Set<string>();
  let attempt = 0;

  while (attempt < MAX_OFFER_ATTEMPTS) {
    const driver = await findBestDriver(merchantLocation, excludedDrivers);

    if (!driver) {
      await new Promise((resolve) => setTimeout(resolve, 10000));
      attempt++;
      continue;
    }

    const offer = await createDriverOffer(orderId, driver.id);
    const response = await waitForOfferResponse(offer.id, OFFER_EXPIRY_SECONDS * 1000);

    if (response === 'accepted') return true;

    excludedDrivers.add(driver.id);
    attempt++;
  }

  await updateOrderStatus(orderId, 'cancelled', {
    cancellation_reason: 'No driver available',
  });

  return false;
}

/**
 * Circuit breaker instance for driver matching.
 *
 * @description Wraps the driver matching function with circuit breaker protection.
 * Opens when error rate exceeds CIRCUIT_BREAKER_ERROR_THRESHOLD (50%) after
 * CIRCUIT_BREAKER_VOLUME_THRESHOLD (3) requests. When open, uses fallback to
 * queue orders for retry instead of attempting matching.
 * @private
 */
const driverMatchingCircuitBreaker = createCircuitBreaker<[string], boolean>(
  'driver-matching',
  async (orderId: string): Promise<boolean> => {
    const startTime = Date.now();

    try {
      const result = await startDriverMatching(orderId);
      const duration = (Date.now() - startTime) / 1000;

      driverMatchingDurationHistogram.observe(duration);

      if (result) {
        driverAssignmentsCounter.inc({ result: 'assigned' });
        matchingLogger.info({ orderId, duration }, 'Driver matching succeeded');
      } else {
        driverAssignmentsCounter.inc({ result: 'no_driver' });
        matchingLogger.warn({ orderId, duration }, 'No driver available for order');
      }

      return result;
    } catch (error) {
      driverAssignmentsCounter.inc({ result: 'error' });
      throw error;
    }
  },
  {
    timeout: DRIVER_MATCHING_TIMEOUT_MS,
    errorThresholdPercentage: CIRCUIT_BREAKER_ERROR_THRESHOLD,
    volumeThreshold: CIRCUIT_BREAKER_VOLUME_THRESHOLD,
    resetTimeout: CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
  }
);

// Fallback: queue order for retry when circuit is open
driverMatchingCircuitBreaker.fallback(async (orderId: string): Promise<boolean> => {
  matchingLogger.warn({ orderId }, 'Circuit breaker open, queueing order for retry');

  await updateOrderStatus(orderId, 'pending', { cancellation_reason: null });
  matchingLogger.error({ orderId }, 'Order queued for retry - circuit breaker open');

  return false;
});

/**
 * Starts driver matching with circuit breaker protection.
 *
 * @description Preferred entry point for initiating driver matching. Wraps the
 * matching algorithm with circuit breaker protection to handle failures gracefully:
 * - When circuit is closed: Executes normal matching algorithm
 * - When circuit is open: Uses fallback to queue order for later retry
 * - When circuit is half-open: Allows test request to check recovery
 *
 * Records metrics for monitoring (duration histogram, assignment counters).
 * @param {string} orderId - The order's UUID to find a driver for
 * @returns {Promise<boolean>} True if driver assigned, false if no driver or circuit open
 * @example
 * // Always use this function for new orders
 * const result = await startDriverMatchingWithCircuitBreaker(orderId);
 * if (!result) {
 *   // Order will either be cancelled or queued for retry
 *   const status = getDriverMatchingCircuitBreakerStatus();
 *   if (status.state === 'open') {
 *     console.log('Order queued - matching service degraded');
 *   }
 * }
 */
export async function startDriverMatchingWithCircuitBreaker(
  orderId: string
): Promise<boolean> {
  try {
    return await driverMatchingCircuitBreaker.fire(orderId);
  } catch (error) {
    matchingLogger.error(
      { orderId, error: (error as Error).message },
      'Driver matching circuit breaker error'
    );
    return false;
  }
}

/**
 * Gets the current status of the driver matching circuit breaker.
 *
 * @description Returns the circuit breaker state and cumulative statistics.
 * Useful for health checks, monitoring dashboards, and debugging.
 * @returns {{state: 'open' | 'halfOpen' | 'closed', stats: {failures: number, successes: number, fallbacks: number, timeouts: number}}} Circuit breaker status object
 * @example
 * const status = getDriverMatchingCircuitBreakerStatus();
 * console.log(`Circuit state: ${status.state}`);
 * console.log(`Failures: ${status.stats.failures}, Successes: ${status.stats.successes}`);
 *
 * if (status.state === 'open') {
 *   console.warn('Driver matching service is degraded');
 * }
 */
export function getDriverMatchingCircuitBreakerStatus() {
  return {
    state: driverMatchingCircuitBreaker.opened
      ? 'open'
      : driverMatchingCircuitBreaker.halfOpen
        ? 'halfOpen'
        : 'closed',
    stats: {
      failures: driverMatchingCircuitBreaker.stats.failures,
      successes: driverMatchingCircuitBreaker.stats.successes,
      fallbacks: driverMatchingCircuitBreaker.stats.fallbacks,
      timeouts: driverMatchingCircuitBreaker.stats.timeouts,
    },
  };
}
