import type { RideData } from '../../types/index.js';
import { query } from '../../utils/db.js';
import redis from '../../utils/redis.js';
import locationService from '../locationService.js';
import type {
  RideWithDriverRow,
  Ride,
  DriverInfo,
} from './types.js';
import { RIDE_PREFIX } from './types.js';

/**
 * @description Retrieves the current status and details of a ride.
 * Uses a two-tier lookup strategy: first checks Redis for active rides (faster),
 * then falls back to PostgreSQL for completed/cancelled rides (comprehensive).
 * For active rides with an assigned driver, includes real-time driver location.
 *
 * @param {string} rideId - Unique identifier of the ride to look up
 * @returns {Promise<Ride | null>} Ride object with current status, locations, driver info, and fare details; null if ride not found
 *
 * @example
 * const ride = await getRideStatus('ride-123');
 * if (ride) {
 *   console.log(`Status: ${ride.status}, Driver: ${ride.driver?.name}`);
 * }
 */
export async function getRideStatus(rideId: string): Promise<Ride | null> {
  // Try Redis first for active rides
  const rideData = await redis.hgetall(`${RIDE_PREFIX}${rideId}`) as unknown as RideData | null;

  if (rideData && rideData.status) {
    const driverLocation = rideData.driverId
      ? await locationService.getDriverLocation(rideData.driverId)
      : null;

    return {
      id: rideId,
      status: rideData.status as Ride['status'],
      pickup: {
        lat: parseFloat(rideData.pickupLat),
        lng: parseFloat(rideData.pickupLng),
      },
      dropoff: {
        lat: parseFloat(rideData.dropoffLat),
        lng: parseFloat(rideData.dropoffLng),
      },
      driverId: rideData.driverId,
      driverLocation,
    };
  }

  // Fall back to database for completed/cancelled rides
  const result = await query<RideWithDriverRow>(
    `SELECT r.*, u.name as driver_name, d.current_lat, d.current_lng,
            d.vehicle_type, d.vehicle_make, d.vehicle_model, d.vehicle_color, d.license_plate
     FROM rides r
     LEFT JOIN users u ON r.driver_id = u.id
     LEFT JOIN drivers d ON r.driver_id = d.user_id
     WHERE r.id = $1`,
    [rideId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const ride = result.rows[0];

  const driverInfo: DriverInfo | null = ride.driver_id
    ? {
        id: ride.driver_id,
        name: ride.driver_name || '',
        vehicleType: ride.vehicle_type,
        vehicleMake: ride.vehicle_make || '',
        vehicleModel: ride.vehicle_model || '',
        vehicleColor: ride.vehicle_color || '',
        licensePlate: ride.license_plate || '',
        location: ride.current_lat
          ? {
              lat: parseFloat(ride.current_lat),
              lng: parseFloat(ride.current_lng!),
              timestamp: Date.now(),
              source: 'postgres' as const,
            }
          : null,
      }
    : null;

  return {
    id: ride.id,
    status: ride.status,
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
    driver: driverInfo,
    fare: {
      estimated: ride.estimated_fare_cents,
      final: ride.final_fare_cents,
      surgeMultiplier: parseFloat(ride.surge_multiplier),
    },
  };
}
