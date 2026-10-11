/**
 * Driver assignment module.
 * Handles driver offers, acceptance/rejection, and assignment.
 *
 * @module services/order/assignment
 * @description Exactly one courier per order is enforced in three layers:
 * 1. An offer is created only if the courier and the order have no other live
 *    offer (partial unique indexes on driver_offers; the pending row acts as a
 *    lease on the courier until expires_at).
 * 2. Accepting is one transaction: compare-and-set the offer from pending to
 *    accepted, then compare-and-set the order from unassigned to
 *    driver_assigned, then mark the courier busy. Any step failing rolls back
 *    all of them.
 * 3. A third unique index allows at most one accepted offer per order.
 */
import { queryOne, execute, withTransaction, isUniqueViolation } from '../../utils/db.js';
import { addDriverOrder, publisher } from '../../utils/redis.js';
import { matchingLogger } from '../../shared/logger.js';
import { transitionOrder, publishOrderStatus, OrderTransitionError } from './stateMachine.js';
import type { Order, DriverOffer } from './types.js';
import { OFFER_EXPIRY_SECONDS } from './types.js';

/** How often the matching loop checks whether the courier answered. */
export const OFFER_POLL_INTERVAL_MS = 1000;

/** Slack after the offer window before the matcher expires the offer itself. */
export const OFFER_DEADLINE_GRACE_MS = 1000;

/**
 * Result of trying to create an offer.
 * - created: the courier now holds the offer (and a lease on their attention)
 * - driver_busy: the courier already holds a live offer for another order
 * - order_has_offer: another matching loop already has a live offer out for this order
 */
export type CreateOfferResult =
  | { status: 'created'; offer: DriverOffer }
  | { status: 'driver_busy' }
  | { status: 'order_has_offer' };

/**
 * Creates a time-limited offer for one courier and notifies them.
 *
 * @param orderId - The order needing a courier
 * @param driverId - The courier receiving the offer
 * @returns The created offer, or why it could not be created
 */
export async function createDriverOffer(orderId: string, driverId: string): Promise<CreateOfferResult> {
  // Offers whose window lapsed while nobody was waiting on them would trip the
  // "one pending offer" indexes; expire them first.
  await execute(
    `UPDATE driver_offers SET status = 'expired'
     WHERE status = 'pending' AND expires_at <= NOW() AND (driver_id = $1 OR order_id = $2)`,
    [driverId, orderId]
  );

  let offer: DriverOffer | null;
  try {
    offer = await queryOne<DriverOffer>(
      `INSERT INTO driver_offers (order_id, driver_id, expires_at)
       VALUES ($1, $2, NOW() + make_interval(secs => $3))
       RETURNING *`,
      [orderId, driverId, OFFER_EXPIRY_SECONDS]
    );
  } catch (error) {
    if (isUniqueViolation(error, 'uniq_driver_offers_pending_per_driver')) {
      return { status: 'driver_busy' };
    }
    if (isUniqueViolation(error, 'uniq_driver_offers_pending_per_order')) {
      return { status: 'order_has_offer' };
    }
    throw error;
  }

  if (!offer) {
    throw new Error('Failed to create driver offer');
  }

  try {
    await publisher.publish(
      `driver:${driverId}:offers`,
      JSON.stringify({
        type: 'new_offer',
        offer_id: offer.id,
        order_id: orderId,
        expires_in: OFFER_EXPIRY_SECONDS,
      })
    );
  } catch (error) {
    // The courier app also polls GET /driver/offers/pending on (re)connect.
    matchingLogger.warn({ orderId, driverId, error: (error as Error).message }, 'Offer notification failed');
  }

  return { status: 'created', offer };
}

/**
 * Waits for the courier to answer an offer, then settles it.
 *
 * When the window closes the matcher expires the offer with a compare-and-set.
 * If that UPDATE matches nothing, the courier answered between the last poll
 * and the expiry, and their answer is returned. (The previous version returned
 * "expired" regardless, re-offered the order to someone else, and could leave
 * two couriers thinking the order was theirs.)
 *
 * @param offerId - The offer's UUID
 * @param deadlineMs - Epoch ms after which the matcher stops waiting
 * @param pollIntervalMs - Polling period
 * @returns The final offer status
 */
export async function waitForOfferResponse(
  offerId: string,
  deadlineMs: number,
  pollIntervalMs: number = OFFER_POLL_INTERVAL_MS
): Promise<'accepted' | 'rejected' | 'expired'> {
  while (Date.now() < deadlineMs) {
    const offer = await queryOne<Pick<DriverOffer, 'status'>>(
      `SELECT status FROM driver_offers WHERE id = $1`,
      [offerId]
    );
    if (offer && offer.status !== 'pending') {
      return offer.status;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const expired = await execute(
    `UPDATE driver_offers SET status = 'expired' WHERE id = $1 AND status = 'pending'`,
    [offerId]
  );
  if (expired === 1) {
    return 'expired';
  }

  // Lost the race to the courier: their answer stands.
  const settled = await queryOne<Pick<DriverOffer, 'status'>>(
    `SELECT status FROM driver_offers WHERE id = $1`,
    [offerId]
  );
  return settled && settled.status !== 'pending' ? settled.status : 'expired';
}

/**
 * Result of a courier tapping Accept.
 */
export type AcceptResult =
  | { status: 'accepted'; order: Order }
  /** Expired, already answered, or not this courier's offer. */
  | { status: 'offer_unavailable' }
  /** The order moved on (cancelled, or assigned through another offer). */
  | { status: 'order_unavailable' }
  /** The courier went offline before accepting. */
  | { status: 'driver_offline' };

/** Thrown inside the accept transaction to roll it back when the courier is offline. */
class DriverOfflineError extends Error {}

/**
 * Accepts an offer: the atomic claim of an order by one courier.
 *
 * @param offerId - The offer's UUID
 * @param driverId - The accepting courier (must own the offer)
 */
export async function acceptDriverOffer(offerId: string, driverId: string): Promise<AcceptResult> {
  let order: Order | null;
  try {
    order = await withTransaction(async (client) => {
      const offer = await client.query<Pick<DriverOffer, 'order_id'>>(
        `UPDATE driver_offers
         SET status = 'accepted', responded_at = NOW()
         WHERE id = $1 AND driver_id = $2 AND status = 'pending' AND expires_at > NOW()
         RETURNING order_id`,
        [offerId, driverId]
      );
      const orderId = offer.rows[0]?.order_id;
      if (!orderId) {
        return null;
      }

      // Only succeeds while the order is unassigned and still dispatchable.
      const assigned = await transitionOrder(orderId, 'driver_assigned', {
        assignDriverId: driverId,
        client,
      });

      const busy = await client.query(
        `UPDATE drivers SET status = 'busy' WHERE id = $1 AND status IN ('available', 'busy')`,
        [driverId]
      );
      if (busy.rowCount === 0) {
        throw new DriverOfflineError();
      }
      return assigned;
    });
  } catch (error) {
    if (
      error instanceof OrderTransitionError ||
      error instanceof DriverOfflineError ||
      isUniqueViolation(error, 'uniq_driver_offers_accepted_per_order')
    ) {
      // The transaction rolled back, so the offer is pending again: withdraw it.
      await execute(
        `UPDATE driver_offers SET status = 'expired', responded_at = NOW()
         WHERE id = $1 AND status = 'pending'`,
        [offerId]
      );
      return { status: error instanceof DriverOfflineError ? 'driver_offline' : 'order_unavailable' };
    }
    throw error;
  }

  if (!order) {
    return { status: 'offer_unavailable' };
  }

  // After COMMIT: best-effort cache of the courier's load, then tell trackers.
  await addDriverOrder(driverId, order.id).catch((error: Error) => {
    matchingLogger.warn({ driverId, orderId: order.id, error: error.message }, 'Failed to cache driver load');
  });
  await publishOrderStatus(order);

  return { status: 'accepted', order };
}

/**
 * Processes a driver's rejection of a delivery offer.
 *
 * @param offerId - The offer's UUID
 * @param driverId - The rejecting driver's UUID (for verification)
 * @returns True if rejection was recorded, false if offer not found or already responded
 */
export async function rejectDriverOffer(
  offerId: string,
  driverId: string
): Promise<boolean> {
  const count = await execute(
    `UPDATE driver_offers
     SET status = 'rejected', responded_at = NOW()
     WHERE id = $1 AND driver_id = $2 AND status = 'pending'`,
    [offerId, driverId]
  );

  return count > 0;
}

/**
 * Retrieves the current pending offer for a driver, if any, with the seconds
 * left computed by the database clock (immune to client clock skew).
 *
 * @param driverId - The driver's UUID
 * @returns Pending offer or null if none exists
 */
export async function getPendingOfferForDriver(
  driverId: string
): Promise<(DriverOffer & { expires_in_seconds: number }) | null> {
  return queryOne<DriverOffer & { expires_in_seconds: number }>(
    `SELECT *, GREATEST(0, CEIL(EXTRACT(EPOCH FROM (expires_at - NOW()))))::int AS expires_in_seconds
     FROM driver_offers
     WHERE driver_id = $1 AND status = 'pending' AND expires_at > NOW()
     ORDER BY offered_at DESC
     LIMIT 1`,
    [driverId]
  );
}

/**
 * Drivers who have already been offered this order (any outcome). Read from the
 * durable offers table, so a matching loop resumed on another instance does not
 * re-offer to couriers who declined or ignored it.
 *
 * @param orderId - The order's UUID
 */
export async function getOfferedDriverIds(orderId: string): Promise<Set<string>> {
  const rows = await queryOne<{ ids: string[] | null }>(
    `SELECT array_agg(DISTINCT driver_id) AS ids FROM driver_offers WHERE order_id = $1`,
    [orderId]
  );
  return new Set(rows?.ids ?? []);
}

/**
 * Marks all expired offers as expired status.
 * Run by the dispatch sweeper so lapsed offers never block the unique indexes.
 *
 * @returns {Promise<number>} Number of offers marked as expired
 */
export async function expireOldOffers(): Promise<number> {
  return execute(
    `UPDATE driver_offers
     SET status = 'expired'
     WHERE status = 'pending' AND expires_at < NOW()`
  );
}
