import type { Location } from '../types/index.js';

/**
 * Calculates the great-circle distance between two geographic points using the Haversine formula.
 * Essential for delivery distance calculations and driver proximity searches.
 *
 * @param point1 - First geographic location
 * @param point2 - Second geographic location
 * @returns Distance between the points in kilometers
 */
export function haversineDistance(point1: Location, point2: Location): number {
  const R = 6371; // Earth's radius in kilometers

  const dLat = toRad(point2.lat - point1.lat);
  const dLng = toRad(point2.lng - point1.lng);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(point1.lat)) *
      Math.cos(toRad(point2.lat)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
}

/**
 * Converts degrees to radians for trigonometric calculations.
 *
 * @param deg - Angle in degrees
 * @returns Angle in radians
 */
function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

/**
 * Estimates travel time based on distance and vehicle type.
 * Uses realistic average speeds accounting for urban traffic, stops, and navigation.
 * Critical for providing customers with accurate delivery ETAs.
 *
 * @param distanceKm - Distance to travel in kilometers
 * @param vehicleType - Type of delivery vehicle (affects speed assumptions)
 * @returns Estimated travel time in seconds
 */
export function calculateETA(
  distanceKm: number,
  vehicleType: VehicleType = 'car'
): number {
  // Average speeds in km/h (accounting for traffic, stops, etc.)
  const speeds: Record<string, number> = {
    bicycle: 15,
    motorcycle: 30,
    car: 25,
    van: 20,
  };

  const speed = speeds[vehicleType] || 25;
  const hours = distanceKm / speed;

  // Return seconds
  return Math.round(hours * 3600);
}

/**
 * Roads are longer than straight lines. 1.3 is a commonly used urban "detour
 * index"; a routing engine would replace this with real road distance.
 */
export const ROAD_DETOUR_FACTOR = 1.3;

/** Vehicle types with an average-speed assumption in calculateETA. */
export type VehicleType = 'bicycle' | 'motorcycle' | 'car' | 'van';

/**
 * Everything needed to estimate when the customer will have their order.
 */
export interface DeliveryEtaInput {
  /** Current order status; decides whether the courier still has to reach the merchant. */
  status: string;
  /** Where the courier is now. */
  courier: Location;
  /** The merchant. */
  pickup: Location;
  /** The customer. */
  dropoff: Location;
  vehicleType?: VehicleType;
  /** Epoch ms when the merchant expects the food to be ready (null if unknown). */
  foodReadyAt?: number | null;
  /** Epoch ms "now" (injectable for tests). */
  now?: number;
}

/**
 * Stage-aware delivery ETA in seconds.
 *
 * Before pickup the courier must still reach the merchant, may have to wait
 * for the food, and then ride to the customer. After pickup only the last leg
 * remains. (The previous calculation always used courier-to-customer distance,
 * which made the ETA too optimistic while the courier was heading to the
 * restaurant.)
 *
 * @param input - Order stage, positions, vehicle and food-ready time
 * @returns Estimated seconds until delivery
 */
export function estimateDeliveryEtaSeconds(input: DeliveryEtaInput): number {
  const travel = (from: Location, to: Location): number =>
    calculateETA(haversineDistance(from, to) * ROAD_DETOUR_FACTOR, input.vehicleType);

  if (input.status === 'picked_up' || input.status === 'in_transit') {
    return travel(input.courier, input.dropoff);
  }

  const now = input.now ?? Date.now();
  const toPickup = travel(input.courier, input.pickup);
  const arriveAtPickup = now + toPickup * 1000;
  const waitForFood = input.foodReadyAt
    ? Math.max(0, Math.round((input.foodReadyAt - arriveAtPickup) / 1000))
    : 0;

  return toPickup + waitForFood + travel(input.pickup, input.dropoff);
}

/**
 * Calculates delivery fee based on distance from merchant to customer.
 * Uses a base fee plus per-kilometer charge model common in delivery platforms.
 *
 * @param distanceKm - Delivery distance in kilometers
 * @param baseFee - Minimum fee charged regardless of distance (default $2.99)
 * @param perKmFee - Additional charge per kilometer (default $0.50)
 * @returns Total delivery fee rounded to 2 decimal places
 */
export function calculateDeliveryFee(
  distanceKm: number,
  baseFee: number = 2.99,
  perKmFee: number = 0.50
): number {
  const fee = baseFee + distanceKm * perKmFee;
  return Math.round(fee * 100) / 100; // Round to 2 decimal places
}

/**
 * Checks if a point falls within a circular delivery zone.
 * Used to determine if a merchant can deliver to a given address.
 *
 * @param point - Location to check
 * @param center - Center of the delivery zone
 * @param radiusKm - Radius of the delivery zone in kilometers
 * @returns True if the point is within the radius
 */
export function isWithinRadius(
  point: Location,
  center: Location,
  radiusKm: number
): boolean {
  return haversineDistance(point, center) <= radiusKm;
}

/**
 * Generates a simplified geohash prefix for a location.
 * Geohashes enable efficient spatial indexing by converting 2D coordinates to a 1D string.
 * Note: This is a demonstration implementation; use a proper geohash library in production.
 *
 * @param lat - Latitude in decimal degrees
 * @param lng - Longitude in decimal degrees
 * @param precision - Length of the geohash prefix (default 5, ~2.4km precision)
 * @returns Geohash string prefix
 */
export function getGeohashPrefix(lat: number, lng: number, precision: number = 5): string {
  // Simplified geohash encoding for demonstration
  // In production, use a proper geohash library
  const latOffset = (lat + 90) / 180;
  const lngOffset = (lng + 180) / 360;

  const base32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let hash = '';
  let latMin = 0, latMax = 1;
  let lngMin = 0, lngMax = 1;
  let isLng = true;

  for (let i = 0; i < precision * 5; i++) {
    if (isLng) {
      const mid = (lngMin + lngMax) / 2;
      if (lngOffset >= mid) {
        hash += '1';
        lngMin = mid;
      } else {
        hash += '0';
        lngMax = mid;
      }
    } else {
      const mid = (latMin + latMax) / 2;
      if (latOffset >= mid) {
        hash += '1';
        latMin = mid;
      } else {
        hash += '0';
        latMax = mid;
      }
    }
    isLng = !isLng;
  }

  // Convert binary to base32
  let result = '';
  for (let i = 0; i < hash.length; i += 5) {
    const chunk = hash.slice(i, i + 5);
    if (chunk.length === 5) {
      const index = parseInt(chunk, 2);
      result += base32[index];
    }
  }

  return result;
}

/**
 * Normalizes an address string for consistent display.
 * Trims whitespace, removes empty parts, and ensures proper comma separation.
 *
 * @param address - Raw address string
 * @returns Formatted address string
 */
export function formatAddress(address: string): string {
  return address
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * Generates a random location within a specified radius of a center point.
 * Useful for testing and simulating driver movements in development.
 *
 * @param center - Center point of the area
 * @param radiusKm - Maximum distance from center in kilometers
 * @returns Random location within the specified radius
 */
export function randomLocationInRadius(
  center: Location,
  radiusKm: number
): Location {
  const radiusInDegrees = radiusKm / 111; // Approximate conversion

  const u = Math.random();
  const v = Math.random();
  const w = radiusInDegrees * Math.sqrt(u);
  const t = 2 * Math.PI * v;

  const deltaLat = w * Math.cos(t);
  const deltaLng = (w * Math.sin(t)) / Math.cos(toRad(center.lat));

  return {
    lat: center.lat + deltaLat,
    lng: center.lng + deltaLng,
  };
}
