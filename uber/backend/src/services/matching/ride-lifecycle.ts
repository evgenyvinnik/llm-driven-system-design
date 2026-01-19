import type { RideRow, RideData } from '../../types/index.js';
import { query } from '../../utils/db.js';
import redis from '../../utils/redis.js';
import locationService from '../locationService.js';
import pricingService from '../pricingService.js';
import { estimateTravelTime } from '../../utils/geo.js';
import { publishToExchange, EXCHANGES } from '../../utils/queue.js';
import { createLogger } from '../../utils/logger.js';
import { metrics } from '../../utils/metrics.js';
import type {
  WSMessage,
  CompleteRideResult,
  CancelRideResult,
} from './types.js';
import { RIDE_PREFIX, PENDING_REQUESTS_KEY } from './types.js';

const logger = createLogger('ride-lifecycle');

/**
 * @description Function signature for sending a message to a user via WebSocket.
 * Used for dependency injection to avoid circular dependencies.
 */
type SendToUserFn = (userId: string, message: WSMessage) => boolean;

/**
 * @description Map storing matching start timestamps for latency tracking.
 * Key: rideId, Value: timestamp in milliseconds when matching started.
 */
type MatchingTimers = Map<string, number>;

let sendToUserFn: SendToUserFn;
let matchingTimers: MatchingTimers;

/**
 * @description Sets the function used to send WebSocket messages to users.
 * This setter pattern is used to break circular dependencies between matching modules.
 *
 * @param {SendToUserFn} fn - Function that sends a WebSocket message to a specific user
 * @returns {void}
 */
export function setSendToUser(fn: SendToUserFn): void {
  sendToUserFn = fn;
}

/**
 * @description Sets the matching timers map for tracking matching latency.
 * This setter pattern is used to share state between matching modules.
 *
 * @param {MatchingTimers} timers - Map containing ride IDs to matching start timestamps
 * @returns {void}
 */
export function setMatchingTimers(timers: MatchingTimers): void {
  matchingTimers = timers;
}

/**
 * @description Marks a ride as having the driver arrived at the pickup location.
 * Updates ride status in both PostgreSQL and Redis, updates metrics,
 * and sends a real-time notification to the rider.
 *
 * @param {string} rideId - Unique identifier of the ride
 * @param {string} driverId - ID of the driver who arrived
 * @returns {Promise<{success: boolean}>} Object indicating operation success
 *
 * @example
 * const result = await driverArrived('ride-123', 'driver-456');
 */
export async function driverArrived(rideId: string, driverId: string): Promise<{ success: boolean }> {
  await query(`UPDATE rides SET status = 'driver_arrived', driver_arrived_at = NOW() WHERE id = $1`, [rideId]);

  await redis.hset(`${RIDE_PREFIX}${rideId}`, 'status', 'driver_arrived');

  const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`) as unknown as RideData | null;

  // Update metrics
  metrics.rideStatusGauge.dec({ status: 'matched' });
  metrics.rideStatusGauge.inc({ status: 'driver_arrived' });

  // Notify rider
  if (rideData) {
    sendToUserFn(rideData.riderId, {
      type: 'driver_arrived',
      rideId,
    });
  }

  logger.info({ rideId, driverId }, 'Driver arrived at pickup');

  return { success: true };
}

/**
 * @description Starts the ride after the rider has been picked up.
 * Transitions the ride from 'driver_arrived' to 'picked_up' status.
 * Updates status in both PostgreSQL and Redis, updates metrics,
 * and notifies the rider that the ride has begun.
 *
 * @param {string} rideId - Unique identifier of the ride
 * @param {string} driverId - ID of the driver starting the ride
 * @returns {Promise<{success: boolean}>} Object indicating operation success
 *
 * @example
 * const result = await startRide('ride-123', 'driver-456');
 */
export async function startRide(rideId: string, driverId: string): Promise<{ success: boolean }> {
  await query(`UPDATE rides SET status = 'picked_up', picked_up_at = NOW() WHERE id = $1`, [rideId]);

  await redis.hset(`${RIDE_PREFIX}${rideId}`, 'status', 'picked_up');

  const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`) as unknown as RideData | null;

  // Update metrics
  metrics.rideStatusGauge.dec({ status: 'driver_arrived' });
  metrics.rideStatusGauge.inc({ status: 'picked_up' });

  // Notify rider
  if (rideData) {
    sendToUserFn(rideData.riderId, {
      type: 'ride_started',
      rideId,
    });
  }

  logger.info({ rideId, driverId }, 'Ride started');

  return { success: true };
}

/**
 * @description Completes a ride after reaching the dropoff location.
 * Calculates the final fare based on actual distance and duration,
 * updates driver statistics and earnings, cleans up Redis state,
 * marks driver as available again, updates metrics, and notifies the rider.
 * Also publishes a completion event to the ride events exchange.
 *
 * @param {string} rideId - Unique identifier of the ride to complete
 * @param {string} driverId - ID of the driver completing the ride
 * @param {number | null} [finalDistanceMeters=null] - Actual distance traveled in meters (uses estimated if null)
 * @returns {Promise<CompleteRideResult>} Result with success status and final fare details, or error message
 *
 * @example
 * const result = await completeRide('ride-123', 'driver-456', 5200);
 * if (result.success) {
 *   console.log(`Final fare: ${result.fare.totalFareCents} cents`);
 * }
 */
export async function completeRide(
  rideId: string,
  driverId: string,
  finalDistanceMeters: number | null = null
): Promise<CompleteRideResult> {
  const rideResult = await query<RideRow>('SELECT * FROM rides WHERE id = $1', [rideId]);
  if (rideResult.rows.length === 0) {
    return { success: false, error: 'Ride not found' };
  }

  const ride = rideResult.rows[0];

  // Calculate final fare
  const distanceKm = (finalDistanceMeters || ride.distance_meters) / 1000;
  const durationMinutes = ride.picked_up_at
    ? Math.ceil((Date.now() - new Date(ride.picked_up_at).getTime()) / 60000)
    : estimateTravelTime(distanceKm);

  const fareDetails = pricingService.calculateFareEstimate(
    distanceKm,
    durationMinutes,
    ride.vehicle_type,
    parseFloat(ride.surge_multiplier)
  );

  // Update ride
  await query(
    `UPDATE rides SET status = 'completed', completed_at = NOW(),
     final_fare_cents = $1, distance_meters = $2, duration_seconds = $3
     WHERE id = $4`,
    [fareDetails.totalFareCents, Math.round(distanceKm * 1000), durationMinutes * 60, rideId]
  );

  // Update driver stats
  await query(
    `UPDATE drivers SET total_rides = total_rides + 1,
     total_earnings_cents = total_earnings_cents + $1,
     is_available = TRUE, updated_at = NOW()
     WHERE user_id = $2`,
    [fareDetails.totalFareCents, driverId]
  );

  // Clean up Redis
  await redis.del(`${RIDE_PREFIX}${rideId}`);

  // Set driver as available again
  const driverLocation = await locationService.getDriverLocation(driverId);
  if (driverLocation) {
    await locationService.setDriverAvailability(driverId, true, driverLocation.lat, driverLocation.lng);
  }

  // Update metrics
  metrics.rideStatusGauge.dec({ status: 'picked_up' });
  metrics.rideRequestsTotal.inc({ vehicle_type: ride.vehicle_type, status: 'completed' });
  metrics.rideFareHistogram.observe({ vehicle_type: ride.vehicle_type }, fareDetails.totalFareCents);

  // Notify rider
  sendToUserFn(ride.rider_id, {
    type: 'ride_completed',
    rideId,
    fare: fareDetails,
  });

  // Publish completed event
  await publishToExchange(EXCHANGES.RIDE_EVENTS, '', {
    eventId: `${rideId}-completed`,
    eventType: 'completed',
    rideId,
    timestamp: Date.now(),
    payload: {
      riderId: ride.rider_id,
      driverId,
      fare: fareDetails.totalFareCents,
      distanceKm,
      durationMinutes,
    },
  });

  logger.info(
    { rideId, driverId, fare: fareDetails.totalFareCents, distanceKm, durationMinutes },
    'Ride completed'
  );

  return {
    success: true,
    fare: fareDetails,
  };
}

/**
 * @description Cancels a ride at any stage before completion.
 * Cleans up Redis state, adjusts demand metrics if ride was still pending,
 * tracks failed matching metrics, makes the driver available if one was assigned,
 * notifies both rider and driver, and publishes a cancellation event.
 *
 * @param {string} rideId - Unique identifier of the ride to cancel
 * @param {string} cancelledBy - User ID of who cancelled (rider, driver, or 'system')
 * @param {string | null} [reason=null] - Optional cancellation reason
 * @returns {Promise<CancelRideResult>} Result with success status or error message
 *
 * @example
 * const result = await cancelRide('ride-123', 'rider-456', 'Changed my mind');
 * if (result.success) {
 *   console.log('Ride cancelled successfully');
 * }
 */
export async function cancelRide(
  rideId: string,
  cancelledBy: string,
  reason: string | null = null
): Promise<CancelRideResult> {
  const rideResult = await query<RideRow>('SELECT * FROM rides WHERE id = $1', [rideId]);
  if (rideResult.rows.length === 0) {
    return { success: false, error: 'Ride not found' };
  }

  const ride = rideResult.rows[0];

  // Update ride
  await query(
    `UPDATE rides SET status = 'cancelled', cancelled_at = NOW(),
     cancelled_by = $1, cancellation_reason = $2 WHERE id = $3`,
    [cancelledBy, reason, rideId]
  );

  // Clean up Redis
  await redis.zrem(PENDING_REQUESTS_KEY, rideId);
  await redis.del(`${RIDE_PREFIX}${rideId}`);

  // Decrement demand if still pending
  if (ride.status === 'requested') {
    await pricingService.decrementDemand(parseFloat(ride.pickup_lat), parseFloat(ride.pickup_lng));

    // Track failed matching
    const matchingStartTime = matchingTimers.get(rideId);
    if (matchingStartTime) {
      const matchingDuration = (Date.now() - matchingStartTime) / 1000;
      metrics.rideMatchingDuration.observe(
        { vehicle_type: ride.vehicle_type, success: 'false' },
        matchingDuration
      );
      matchingTimers.delete(rideId);
    }
  }

  // Update metrics
  metrics.rideStatusGauge.dec({ status: ride.status });
  metrics.rideRequestsTotal.inc({ vehicle_type: ride.vehicle_type, status: 'cancelled' });

  // If driver was assigned, make them available
  if (ride.driver_id) {
    const driverLocation = await locationService.getDriverLocation(ride.driver_id);
    if (driverLocation) {
      await locationService.setDriverAvailability(ride.driver_id, true, driverLocation.lat, driverLocation.lng);
    }

    // Notify driver
    sendToUserFn(ride.driver_id, {
      type: 'ride_cancelled',
      rideId,
      cancelledBy,
      reason,
    });
  }

  // Notify rider
  sendToUserFn(ride.rider_id, {
    type: 'ride_cancelled',
    rideId,
    cancelledBy,
    reason,
  });

  // Publish cancelled event
  await publishToExchange(EXCHANGES.RIDE_EVENTS, '', {
    eventId: `${rideId}-cancelled`,
    eventType: 'cancelled',
    rideId,
    timestamp: Date.now(),
    payload: {
      riderId: ride.rider_id,
      driverId: ride.driver_id,
      cancelledBy,
      reason,
    },
  });

  logger.info({ rideId, cancelledBy, reason }, 'Ride cancelled');

  return { success: true };
}

/**
 * @description Handles the scenario when no drivers are available for a ride request.
 * Called after all matching attempts have been exhausted without finding a driver.
 * Cancels the ride with 'system' as the canceller and 'No drivers available' reason,
 * cleans up Redis state, adjusts demand and matching metrics, and notifies the rider.
 *
 * @param {string} rideId - Unique identifier of the ride that couldn't be matched
 * @returns {Promise<void>} Resolves when cleanup and notification are complete
 *
 * @example
 * await handleNoDriversFound('ride-123');
 * // Rider receives 'no_drivers_available' WebSocket message
 */
export async function handleNoDriversFound(rideId: string): Promise<void> {
  await query(
    `UPDATE rides SET status = 'cancelled', cancelled_at = NOW(), cancelled_by = 'system', cancellation_reason = 'No drivers available' WHERE id = $1`,
    [rideId]
  );

  const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`) as unknown as RideData | null;

  // Clean up Redis
  await redis.zrem(PENDING_REQUESTS_KEY, rideId);
  await redis.del(`${RIDE_PREFIX}${rideId}`);

  if (rideData) {
    await pricingService.decrementDemand(parseFloat(rideData.pickupLat), parseFloat(rideData.pickupLng));

    // Track failed matching
    const matchingStartTime = matchingTimers.get(rideId);
    if (matchingStartTime) {
      const matchingDuration = (Date.now() - matchingStartTime) / 1000;
      metrics.rideMatchingDuration.observe(
        { vehicle_type: rideData.vehicleType, success: 'false' },
        matchingDuration
      );
      matchingTimers.delete(rideId);
    }

    // Update metrics
    metrics.rideStatusGauge.dec({ status: 'requested' });
    metrics.rideRequestsTotal.inc({ vehicle_type: rideData.vehicleType, status: 'no_drivers' });

    // Notify rider
    sendToUserFn(rideData.riderId, {
      type: 'no_drivers_available',
      rideId,
    });
  }

  logger.info({ rideId }, 'No drivers available');
}
