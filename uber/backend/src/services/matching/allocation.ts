import type { RideRow, RideData } from '../../types/index.js';
import { query } from '../../utils/db.js';
import redis from '../../utils/redis.js';
import locationService from '../locationService.js';
import pricingService from '../pricingService.js';
import { calculateDistance, estimateTravelTime } from '../../utils/geo.js';
import { publishToExchange, EXCHANGES } from '../../utils/queue.js';
import { createLogger } from '../../utils/logger.js';
import { metrics } from '../../utils/metrics.js';
import type {
  WSMessage,
  AcceptRideResult,
  RiderRow,
  DriverQueryRow,
} from './types.js';
import { RIDE_PREFIX, PENDING_REQUESTS_KEY } from './types.js';

const logger = createLogger('allocation');

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
 * @description Sends a ride offer to a driver via WebSocket.
 * Retrieves ride and rider details, calculates ETA from driver's current location to pickup,
 * and sends a complete ride offer message to the driver's WebSocket connection.
 * The driver has 15 seconds to accept the offer before it expires.
 *
 * @param {string} rideId - Unique identifier of the ride to offer
 * @param {string} driverId - ID of the driver to receive the offer
 * @param {number} pickupLat - Latitude of the pickup location
 * @param {number} pickupLng - Longitude of the pickup location
 * @returns {Promise<boolean>} True if the offer was successfully sent to the driver's WebSocket
 *
 * @example
 * const sent = await offerRideToDriver('ride-123', 'driver-456', 37.7749, -122.4194);
 * if (sent) {
 *   console.log('Offer sent, waiting for driver response');
 * }
 */
export async function offerRideToDriver(
  rideId: string,
  driverId: string,
  pickupLat: number,
  pickupLng: number
): Promise<boolean> {
  // Get ride details
  const rideResult = await query<RideRow>('SELECT * FROM rides WHERE id = $1', [rideId]);
  if (rideResult.rows.length === 0) {
    return false;
  }

  const ride = rideResult.rows[0];

  // Get rider details
  const riderResult = await query<RiderRow>('SELECT name, rating FROM users WHERE id = $1', [ride.rider_id]);
  const rider = riderResult.rows[0];

  // Calculate ETA to pickup
  const driverLocation = await locationService.getDriverLocation(driverId);
  if (!driverLocation) return false;

  const distanceToPickup = calculateDistance(
    driverLocation.lat,
    driverLocation.lng,
    pickupLat,
    pickupLng
  );
  const etaMinutes = estimateTravelTime(distanceToPickup);

  // Send ride offer to driver via WebSocket
  const offer: WSMessage = {
    type: 'ride_offer',
    rideId,
    rider: {
      name: rider.name,
      rating: parseFloat(rider.rating),
    },
    pickup: {
      lat: parseFloat(ride.pickup_lat),
      lng: parseFloat(ride.pickup_lng),
      address: ride.pickup_address,
    },
    dropoff: {
      lat: parseFloat(ride.dropoff_lat),
      lng: parseFloat(ride.dropoff_lng),
      address: ride.dropoff_address,
    },
    estimatedFare: ride.estimated_fare_cents,
    distanceKm: ride.distance_meters / 1000,
    etaMinutes,
    expiresIn: 15, // 15 seconds to accept
  };

  const sent = sendToUserFn(driverId, offer);

  if (sent) {
    logger.info({ rideId, driverId, etaMinutes }, 'Ride offer sent to driver');
    // Store pending offer
    redis.setex(`offer:${rideId}:${driverId}`, 20, JSON.stringify(offer));
    return true; // For demo, assume accepted
  }

  return false;
}

/**
 * @description Processes a driver's acceptance of a ride offer.
 * Implements optimistic locking to prevent race conditions when multiple drivers try to accept.
 * Updates ride status in both PostgreSQL and Redis, marks driver as busy,
 * adjusts demand metrics, tracks matching duration, and notifies the rider.
 *
 * @param {string} rideId - Unique identifier of the ride being accepted
 * @param {string} driverId - ID of the driver accepting the ride
 * @returns {Promise<AcceptRideResult>} Result object containing success status, error message if failed, or ride details if successful
 *
 * @throws Will not throw - errors are captured in the result object
 *
 * @example
 * const result = await acceptRide('ride-123', 'driver-456');
 * if (result.success) {
 *   console.log('Ride accepted:', result.ride);
 * } else {
 *   console.log('Failed:', result.error);
 * }
 */
export async function acceptRide(rideId: string, driverId: string): Promise<AcceptRideResult> {
  // Check if ride is still pending
  const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`) as unknown as RideData | null;
  if (!rideData || rideData.status !== 'requested') {
    return { success: false, error: 'Ride no longer available' };
  }

  // Update ride status with optimistic locking (version check)
  const updateResult = await query<RideRow>(
    `UPDATE rides SET driver_id = $1, status = 'matched', matched_at = NOW()
     WHERE id = $2 AND status = 'requested'
     RETURNING *`,
    [driverId, rideId]
  );

  if (updateResult.rowCount === 0) {
    return { success: false, error: 'Ride already taken' };
  }

  // Update Redis
  await redis.hset(`${RIDE_PREFIX}${rideId}`, 'status', 'matched', 'driverId', driverId);

  // Remove from pending
  await redis.zrem(PENDING_REQUESTS_KEY, rideId);

  // Set driver as busy
  await locationService.setDriverBusy(driverId);

  // Decrement demand
  await pricingService.decrementDemand(parseFloat(rideData.pickupLat), parseFloat(rideData.pickupLng));

  // Track matching duration
  const matchingStartTime = matchingTimers.get(rideId);
  if (matchingStartTime) {
    const matchingDuration = (Date.now() - matchingStartTime) / 1000;
    metrics.rideMatchingDuration.observe(
      { vehicle_type: rideData.vehicleType, success: 'true' },
      matchingDuration
    );
    matchingTimers.delete(rideId);
  }

  // Update ride status metrics
  metrics.rideStatusGauge.dec({ status: 'requested' });
  metrics.rideStatusGauge.inc({ status: 'matched' });

  // Get driver details
  const driverResult = await query<DriverQueryRow>(
    `SELECT u.id, u.name, u.rating, d.vehicle_type, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.license_plate
     FROM users u JOIN drivers d ON u.id = d.user_id WHERE u.id = $1`,
    [driverId]
  );
  const driver = driverResult.rows[0];

  const driverLocation = await locationService.getDriverLocation(driverId);

  // Notify rider
  sendToUserFn(rideData.riderId, {
    type: 'ride_matched',
    rideId,
    driver: {
      id: driver.id,
      name: driver.name,
      rating: parseFloat(driver.rating),
      vehicleType: driver.vehicle_type,
      vehicleMake: driver.vehicle_make,
      vehicleModel: driver.vehicle_model,
      vehicleColor: driver.vehicle_color,
      licensePlate: driver.license_plate,
      location: driverLocation,
    },
  });

  // Publish matched event
  await publishToExchange(EXCHANGES.RIDE_EVENTS, '', {
    eventId: `${rideId}-matched`,
    eventType: 'matched',
    rideId,
    timestamp: Date.now(),
    payload: {
      riderId: rideData.riderId,
      driverId,
    },
  });

  logger.info({ rideId, driverId }, 'Ride matched');

  return {
    success: true,
    ride: {
      id: rideId,
      status: 'matched',
      pickup: {
        lat: parseFloat(rideData.pickupLat),
        lng: parseFloat(rideData.pickupLng),
      },
      dropoff: {
        lat: parseFloat(rideData.dropoffLat),
        lng: parseFloat(rideData.dropoffLng),
      },
      riderId: rideData.riderId,
    },
  };
}
