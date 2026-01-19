import type { VehicleType, RideRow, MatchingRequest } from '../../types/index.js';
import redis from '../../utils/redis.js';
import locationService from '../locationService.js';
import config from '../../config/index.js';
import { publishToQueue, QUEUES } from '../../utils/queue.js';
import { createLogger } from '../../utils/logger.js';
import { scoreDrivers } from './scoring.js';
import { RIDE_PREFIX } from './types.js';

const logger = createLogger('driver-finder');

/**
 * @description Function signature for offering a ride to a specific driver.
 * Used for dependency injection to avoid circular dependencies between modules.
 */
type OfferRideToDriverFn = (
  rideId: string,
  driverId: string,
  pickupLat: number,
  pickupLng: number
) => Promise<boolean>;

/**
 * @description Function signature for handling the case when no drivers are found.
 * Used for dependency injection to avoid circular dependencies between modules.
 */
type HandleNoDriversFoundFn = (rideId: string) => Promise<void>;

let offerRideToDriverFn: OfferRideToDriverFn;
let handleNoDriversFoundFn: HandleNoDriversFoundFn;

/**
 * @description Sets the function used to offer rides to drivers.
 * This setter pattern is used to break circular dependencies between matching modules.
 *
 * @param {OfferRideToDriverFn} fn - Function that sends a ride offer to a driver via WebSocket
 * @returns {void}
 */
export function setOfferRideToDriver(fn: OfferRideToDriverFn): void {
  offerRideToDriverFn = fn;
}

/**
 * @description Sets the function called when no drivers are available for a ride.
 * This setter pattern is used to break circular dependencies between matching modules.
 *
 * @param {HandleNoDriversFoundFn} fn - Function that handles the no-drivers-found scenario
 * @returns {void}
 */
export function setHandleNoDriversFound(fn: HandleNoDriversFoundFn): void {
  handleNoDriversFoundFn = fn;
}

/**
 * @description Finds and matches a driver for a pending ride request.
 * Implements progressive radius expansion strategy: search radius increases with each attempt.
 * Scores and ranks available drivers, then offers the ride to them in order of score.
 * If no drivers are found or all decline, requeues the request with an incremented attempt count.
 * After max attempts (3), calls the no-drivers-found handler to cancel the ride.
 *
 * @param {string} rideId - Unique identifier of the ride to match
 * @param {number} pickupLat - Latitude of the pickup location
 * @param {number} pickupLng - Longitude of the pickup location
 * @param {VehicleType} vehicleType - Type of vehicle requested (economy, comfort, premium)
 * @param {number} [attempt=1] - Current attempt number (1-3), controls search radius expansion
 * @returns {Promise<void>} Resolves when matching attempt completes (driver found or requeued)
 *
 * @example
 * await findDriver('ride-123', 37.7749, -122.4194, 'economy', 1);
 */
export async function findDriver(
  rideId: string,
  pickupLat: number,
  pickupLng: number,
  vehicleType: VehicleType,
  attempt: number = 1
): Promise<void> {
  const maxAttempts = 3;
  const radiusMultiplier = attempt; // Expand radius with each attempt

  const radiusKm = Math.min(
    config.matching.searchRadiusKm * radiusMultiplier,
    config.matching.maxSearchRadiusKm
  );

  logger.debug({ rideId, attempt, radiusKm }, 'Searching for nearby drivers');

  // Find nearby drivers
  let drivers = await locationService.findNearbyDrivers(pickupLat, pickupLng, radiusKm);

  // Filter by vehicle type if specified
  if (vehicleType !== 'economy') {
    drivers = drivers.filter((d) => d.vehicleType === vehicleType);
  }

  if (drivers.length === 0) {
    if (attempt < maxAttempts) {
      // Requeue with incremented attempt after delay
      setTimeout(async () => {
        await publishToQueue(QUEUES.MATCHING_REQUESTS, {
          requestId: `${rideId}-attempt-${attempt + 1}`,
          rideId,
          pickupLocation: { lat: pickupLat, lng: pickupLng },
          dropoffLocation: { lat: 0, lng: 0 }, // Will be ignored in retry
          vehicleType,
          attempt: attempt + 1,
        });
      }, 5000);
      return;
    }

    // No drivers found after all attempts
    await handleNoDriversFoundFn(rideId);
    return;
  }

  // Score and rank drivers
  const scoredDrivers = scoreDrivers(drivers, pickupLat, pickupLng);

  // Try to match with best driver
  for (const driver of scoredDrivers) {
    const matched = await offerRideToDriverFn(rideId, driver.id, pickupLat, pickupLng);
    if (matched) {
      return; // Successfully matched
    }
  }

  // All drivers declined, retry
  if (attempt < maxAttempts) {
    setTimeout(async () => {
      await publishToQueue(QUEUES.MATCHING_REQUESTS, {
        requestId: `${rideId}-attempt-${attempt + 1}`,
        rideId,
        pickupLocation: { lat: pickupLat, lng: pickupLng },
        dropoffLocation: { lat: 0, lng: 0 },
        vehicleType,
        attempt: attempt + 1,
      });
    }, 5000);
  } else {
    await handleNoDriversFoundFn(rideId);
  }
}

/**
 * @description Processes a matching request message from the RabbitMQ queue.
 * Validates that the ride is still in 'requested' status before attempting to find a driver.
 * This prevents processing stale requests for rides that have already been matched, cancelled, or completed.
 *
 * @param {MatchingRequest} message - The matching request message from the queue
 * @param {string} message.rideId - Unique identifier of the ride
 * @param {Object} message.pickupLocation - Pickup coordinates
 * @param {number} message.pickupLocation.lat - Pickup latitude
 * @param {number} message.pickupLocation.lng - Pickup longitude
 * @param {VehicleType} message.vehicleType - Requested vehicle type
 * @param {number} message.attempt - Current matching attempt number
 * @returns {Promise<void>} Resolves when request processing completes
 */
export async function processMatchingRequest(message: MatchingRequest): Promise<void> {
  const { rideId, pickupLocation, vehicleType, attempt } = message;

  logger.debug({ rideId, attempt }, 'Processing matching request from queue');

  // Check if ride is still pending
  const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`);
  if (!rideData || rideData.status !== 'requested') {
    logger.info({ rideId }, 'Ride no longer pending, skipping matching');
    return;
  }

  await findDriver(
    rideId,
    pickupLocation.lat,
    pickupLocation.lng,
    vehicleType,
    attempt
  );
}
