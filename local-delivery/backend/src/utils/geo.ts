import type { Location } from '../types/index.js';

// Haversine formula to calculate distance between two points in km
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

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}

// Calculate estimated time based on distance and vehicle type
export function calculateETA(
  distanceKm: number,
  vehicleType: 'bicycle' | 'motorcycle' | 'car' | 'van' = 'car'
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

// Calculate delivery fee based on distance
export function calculateDeliveryFee(
  distanceKm: number,
  baseFee: number = 2.99,
  perKmFee: number = 0.50
): number {
  const fee = baseFee + distanceKm * perKmFee;
  return Math.round(fee * 100) / 100; // Round to 2 decimal places
}

// Check if a point is within a radius of a center point
export function isWithinRadius(
  point: Location,
  center: Location,
  radiusKm: number
): boolean {
  return haversineDistance(point, center) <= radiusKm;
}

// Get geohash prefix for a location (simplified version)
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

// Format address for display
export function formatAddress(address: string): string {
  return address
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

// Generate random location within radius (for testing)
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
