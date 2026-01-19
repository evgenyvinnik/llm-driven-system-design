import redis from '../utils/redis.js';
import config from '../config/index.js';
import { calculateDistance, kmToMiles, estimateTravelTime, encodeGeohash } from '../utils/geo.js';
import locationService from './locationService.js';
import type { FareEstimate, SurgeInfo, VehicleType } from '../types/index.js';

const DEMAND_PREFIX = 'demand:';
const DEMAND_TTL = 300; // 5 minutes

class PricingService {
  // Calculate fare estimate
  calculateFareEstimate(
    distanceKm: number,
    durationMinutes: number,
    vehicleType: VehicleType,
    surgeMultiplier: number = 1.0
  ): FareEstimate {
    const { baseFareCents, perMileCents, perMinuteCents, minimumFareCents, vehicleMultipliers } = config.pricing;

    const distanceMiles = kmToMiles(distanceKm);
    const vehicleMultiplier = vehicleMultipliers[vehicleType] || 1.0;

    const distanceFare = distanceMiles * perMileCents;
    const timeFare = durationMinutes * perMinuteCents;
    const baseFare = baseFareCents;

    let totalFare = Math.ceil((baseFare + distanceFare + timeFare) * vehicleMultiplier * surgeMultiplier);
    totalFare = Math.max(totalFare, minimumFareCents);

    return {
      baseFareCents: baseFare,
      distanceFareCents: Math.ceil(distanceFare),
      timeFareCents: Math.ceil(timeFare),
      vehicleMultiplier,
      surgeMultiplier,
      totalFareCents: totalFare,
      distanceKm,
      distanceMiles: parseFloat(distanceMiles.toFixed(2)),
      durationMinutes,
    };
  }

  // Get fare estimate for a route
  async getFareEstimate(
    pickupLat: number,
    pickupLng: number,
    dropoffLat: number,
    dropoffLng: number,
    vehicleType: VehicleType = 'economy'
  ): Promise<FareEstimate> {
    const distanceKm = calculateDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);
    const durationMinutes = estimateTravelTime(distanceKm);

    // Get surge multiplier for pickup location
    const surgeMultiplier = await this.getSurgeMultiplier(pickupLat, pickupLng);

    return this.calculateFareEstimate(distanceKm, durationMinutes, vehicleType, surgeMultiplier);
  }

  // Get fare estimates for all vehicle types
  async getAllFareEstimates(
    pickupLat: number,
    pickupLng: number,
    dropoffLat: number,
    dropoffLng: number
  ): Promise<FareEstimate[]> {
    const distanceKm = calculateDistance(pickupLat, pickupLng, dropoffLat, dropoffLng);
    const durationMinutes = estimateTravelTime(distanceKm);
    const surgeMultiplier = await this.getSurgeMultiplier(pickupLat, pickupLng);

    const vehicleTypes: VehicleType[] = ['economy', 'comfort', 'premium', 'xl'];

    return vehicleTypes.map((type) => ({
      vehicleType: type,
      ...this.calculateFareEstimate(distanceKm, durationMinutes, type, surgeMultiplier),
    }));
  }

  // Calculate surge multiplier based on supply/demand
  async getSurgeMultiplier(lat: number, lng: number): Promise<number> {
    const geohash = encodeGeohash(lat, lng, 5); // ~5km precision

    // Get demand count for this area
    const demandKey = `${DEMAND_PREFIX}${geohash}`;
    const demand = parseInt((await redis.get(demandKey)) || '0', 10);

    // Get supply (available drivers) count
    const supply = await locationService.countAvailableDrivers(lat, lng, 3);

    // Calculate surge
    return this.calculateSurge(supply, demand);
  }

  // Calculate surge based on supply/demand ratio
  calculateSurge(availableDrivers: number, pendingRequests: number): number {
    if (availableDrivers === 0) {
      return pendingRequests > 0 ? 2.5 : 1.0;
    }

    const ratio = availableDrivers / Math.max(pendingRequests, 1);

    if (ratio > 2) return 1.0; // Plenty of drivers
    if (ratio > 1.5) return 1.1;
    if (ratio > 1) return 1.2;
    if (ratio > 0.75) return 1.5;
    if (ratio > 0.5) return 1.8;
    if (ratio > 0.25) return 2.0;
    return 2.5; // Very high demand
  }

  // Increment demand counter (called when ride is requested)
  async incrementDemand(lat: number, lng: number): Promise<void> {
    const geohash = encodeGeohash(lat, lng, 5);
    const demandKey = `${DEMAND_PREFIX}${geohash}`;

    await redis.multi().incr(demandKey).expire(demandKey, DEMAND_TTL).exec();
  }

  // Decrement demand counter (called when ride is matched or cancelled)
  async decrementDemand(lat: number, lng: number): Promise<void> {
    const geohash = encodeGeohash(lat, lng, 5);
    const demandKey = `${DEMAND_PREFIX}${geohash}`;

    const current = parseInt((await redis.get(demandKey)) || '0', 10);
    if (current > 0) {
      await redis.decr(demandKey);
    }
  }

  // Get surge info for display
  async getSurgeInfo(lat: number, lng: number): Promise<SurgeInfo> {
    const multiplier = await this.getSurgeMultiplier(lat, lng);
    const geohash = encodeGeohash(lat, lng, 5);
    const demandKey = `${DEMAND_PREFIX}${geohash}`;

    const demand = parseInt((await redis.get(demandKey)) || '0', 10);
    const supply = await locationService.countAvailableDrivers(lat, lng, 3);

    return {
      multiplier,
      demand,
      supply,
      isActive: multiplier > 1.0,
      message:
        multiplier > 1.0
          ? `Prices are ${multiplier}x higher due to high demand`
          : 'Normal pricing',
    };
  }
}

export default new PricingService();
