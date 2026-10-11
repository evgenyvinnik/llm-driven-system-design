/**
 * Driver matching module.
 * Handles driver matching logic with circuit breaker protection.
 *
 * @module services/order/matching
 * @description Sequential offers: the best-scoring nearby courier gets an
 * exclusive 30-second offer; on decline or timeout the next one does. The loop
 * keeps its state in PostgreSQL rather than in memory:
 * - who has already been offered the order comes from driver_offers, so a loop
 *   resumed on another instance does not re-offer to couriers who said no;
 * - the dispatch lease is renewed before every offer and the loop stops as
 *   soon as it no longer holds it (assigned, cancelled, or taken over);
 * - when nobody is nearby the loop releases the lease with a delay and the
 *   dispatch sweeper (any instance) retries, instead of sleeping in-process.
 * When the circuit breaker is open, the fallback does the same release with a
 * longer delay: that is the "retry queue".
 */
import { findBestDriver, updateDriverAcceptanceRate } from '../driverService.js';
import { createCircuitBreaker } from '../../shared/circuitBreaker.js';
import { matchingLogger } from '../../shared/logger.js';
import {
  driverAssignmentsCounter,
  driverMatchingDurationHistogram,
  offersPerAssignmentHistogram,
} from '../../shared/metrics.js';
import { getOrderWithDetails } from './tracking.js';
import {
  createDriverOffer,
  waitForOfferResponse,
  getOfferedDriverIds,
  OFFER_DEADLINE_GRACE_MS,
} from './assignment.js';
import { cancelOrder } from './cancel.js';
import { DISPATCHABLE_STATUSES, OrderTransitionError } from './stateMachine.js';
import {
  DISPATCH_OWNER,
  DISPATCH_RETRY_DELAY_SECONDS,
  DISPATCH_FAILURE_BACKOFF_SECONDS,
  renewDispatchLease,
  releaseDispatchLease,
} from './dispatch.js';
import type { Location } from './types.js';
import {
  OFFER_EXPIRY_SECONDS,
  MAX_OFFER_ATTEMPTS,
  DRIVER_MATCHING_TIMEOUT_MS,
  CIRCUIT_BREAKER_ERROR_THRESHOLD,
  CIRCUIT_BREAKER_VOLUME_THRESHOLD,
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
} from './types.js';

/**
 * How a matching run ended.
 * - assigned: a courier accepted
 * - deferred: lease released with a delay; a sweeper will retry
 * - cancelled: gave up (deadline or offer limit reached)
 * - lease_lost: the order no longer needs this loop (assigned, cancelled, or owned elsewhere)
 */
export type MatchOutcome = 'assigned' | 'deferred' | 'cancelled' | 'lease_lost';

/**
 * Cancels an order that could not be matched, if it is still unassigned.
 */
async function giveUp(orderId: string, reason: string): Promise<MatchOutcome> {
  try {
    await cancelOrder(orderId, { from: DISPATCHABLE_STATUSES, reason });
    driverAssignmentsCounter.inc({ result: 'no_driver' });
    matchingLogger.warn({ orderId, reason }, 'Order cancelled: no courier');
    return 'cancelled';
  } catch (error) {
    if (error instanceof OrderTransitionError) {
      // Assigned or cancelled by someone else a moment ago.
      return 'lease_lost';
    }
    throw error;
  }
}

/**
 * Runs the sequential-offer loop for one order while this instance holds its lease.
 *
 * @param orderId - The order's UUID to find a driver for
 * @param owner - Lease owner id (this instance)
 * @returns How the run ended
 */
export async function startDriverMatching(
  orderId: string,
  owner: string = DISPATCH_OWNER
): Promise<MatchOutcome> {
  const order = await getOrderWithDetails(orderId);
  if (!order || !order.merchant) return 'lease_lost';

  const pickup: Location = {
    lat: Number(order.merchant.lat),
    lng: Number(order.merchant.lng),
  };

  // Couriers who already hold another order's offer during this pass.
  const busyThisPass = new Set<string>();

  for (;;) {
    const lease = await renewDispatchLease(orderId, owner);
    if (!lease) return 'lease_lost';
    if (lease.pastDeadline) return giveUp(orderId, 'No driver available');

    const alreadyOffered = await getOfferedDriverIds(orderId);
    if (alreadyOffered.size >= MAX_OFFER_ATTEMPTS) {
      return giveUp(orderId, 'No driver accepted the order');
    }

    const driver = await findBestDriver(pickup, new Set([...alreadyOffered, ...busyThisPass]));
    if (!driver) {
      await releaseDispatchLease(orderId, owner, DISPATCH_RETRY_DELAY_SECONDS);
      return 'deferred';
    }

    const created = await createDriverOffer(orderId, driver.id);
    if (created.status === 'driver_busy') {
      busyThisPass.add(driver.id);
      continue;
    }
    if (created.status === 'order_has_offer') {
      // Another loop has an offer out; let it finish.
      await releaseDispatchLease(orderId, owner, DISPATCH_RETRY_DELAY_SECONDS);
      return 'deferred';
    }

    matchingLogger.info({ orderId, driverId: driver.id, offerId: created.offer.id }, 'Offer sent');
    const response = await waitForOfferResponse(
      created.offer.id,
      Date.now() + OFFER_EXPIRY_SECONDS * 1000 + OFFER_DEADLINE_GRACE_MS
    );
    driverAssignmentsCounter.inc({ result: response });
    updateDriverAcceptanceRate(driver.id).catch((error: Error) => {
      matchingLogger.warn({ driverId: driver.id, error: error.message }, 'Acceptance rate update failed');
    });

    if (response === 'accepted') {
      offersPerAssignmentHistogram.observe(alreadyOffered.size + 1);
      return 'assigned';
    }
  }
}

/**
 * Circuit breaker instance for driver matching.
 *
 * @description Opens when error rate exceeds CIRCUIT_BREAKER_ERROR_THRESHOLD (50%)
 * after CIRCUIT_BREAKER_VOLUME_THRESHOLD (3) runs. A "deferred" or "cancelled"
 * run is a success: only thrown errors (Redis or PostgreSQL failing) count.
 * @private
 */
const driverMatchingCircuitBreaker = createCircuitBreaker<[string], MatchOutcome>(
  'driver-matching',
  async (orderId: string): Promise<MatchOutcome> => {
    const startTime = Date.now();
    const outcome = await startDriverMatching(orderId);
    const duration = (Date.now() - startTime) / 1000;

    if (outcome === 'assigned') {
      driverMatchingDurationHistogram.observe(duration);
    }
    matchingLogger.info({ orderId, outcome, duration }, 'Matching run finished');
    return outcome;
  },
  {
    timeout: DRIVER_MATCHING_TIMEOUT_MS,
    errorThresholdPercentage: CIRCUIT_BREAKER_ERROR_THRESHOLD,
    volumeThreshold: CIRCUIT_BREAKER_VOLUME_THRESHOLD,
    resetTimeout: CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
  }
);

// Fallback (circuit open, error, or timeout): hand the order back to the
// sweepers with a back-off. The order stays unassigned; nothing is overwritten.
driverMatchingCircuitBreaker.fallback(async (orderId: string): Promise<MatchOutcome> => {
  matchingLogger.warn({ orderId }, 'Matching unavailable; order will be retried by the dispatch sweeper');
  await releaseDispatchLease(orderId, DISPATCH_OWNER, DISPATCH_FAILURE_BACKOFF_SECONDS).catch(
    (error: Error) => {
      // If even this fails the lease simply expires and a sweeper retries.
      matchingLogger.error({ orderId, error: error.message }, 'Failed to release dispatch lease');
    }
  );
  return 'deferred';
});

/** Orders whose matching loop is running in this process. */
const matchingInProgress = new Set<string>();

/**
 * Starts driver matching with circuit breaker protection.
 * Safe to call repeatedly for the same order: a second call while a loop is
 * already running in this process is a no-op.
 *
 * @param orderId - The order's UUID to find a driver for
 * @returns How the run ended
 */
export async function startDriverMatchingWithCircuitBreaker(orderId: string): Promise<MatchOutcome> {
  if (matchingInProgress.has(orderId)) {
    return 'lease_lost';
  }
  matchingInProgress.add(orderId);
  try {
    return await driverMatchingCircuitBreaker.fire(orderId);
  } catch (error) {
    matchingLogger.error(
      { orderId, error: (error as Error).message },
      'Driver matching circuit breaker error'
    );
    return 'deferred';
  } finally {
    matchingInProgress.delete(orderId);
  }
}

/**
 * Gets the current status of the driver matching circuit breaker.
 *
 * @returns Circuit breaker state and cumulative statistics
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

/** Exposed for tests and shutdown: orders being matched in this process. */
export function getMatchingInProgress(): ReadonlySet<string> {
  return matchingInProgress;
}
