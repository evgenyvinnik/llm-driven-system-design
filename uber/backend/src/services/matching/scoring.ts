import type { NearbyDriver, ScoredDriver } from '../../types/index.js';
import { estimateTravelTime } from '../../utils/geo.js';

/**
 * @description Scores and ranks nearby drivers based on ETA and rating to determine the best match for a ride.
 * Uses a weighted combination of 60% ETA score and 40% rating score.
 * Lower ETA produces higher scores (inverted and normalized to 0-1 range assuming max 30 min ETA).
 * Higher ratings produce higher scores (normalized from 3-5 rating scale to 0-1 range).
 *
 * @param {NearbyDriver[]} drivers - Array of nearby drivers with their distances and ratings
 * @param {number} _pickupLat - Pickup latitude (currently unused, reserved for future geo-based scoring)
 * @param {number} _pickupLng - Pickup longitude (currently unused, reserved for future geo-based scoring)
 * @returns {ScoredDriver[]} Array of drivers with computed ETA and scores, sorted by score descending (best first)
 *
 * @example
 * const scoredDrivers = scoreDrivers(nearbyDrivers, 37.7749, -122.4194);
 * const bestDriver = scoredDrivers[0]; // Highest scored driver
 */
export function scoreDrivers(
  drivers: NearbyDriver[],
  _pickupLat: number,
  _pickupLng: number
): ScoredDriver[] {
  const scored = drivers.map((driver) => {
    const eta = estimateTravelTime(driver.distanceKm);

    // Lower ETA is better (invert and normalize)
    const etaScore = Math.max(0, 1 - eta / 30);

    // Higher rating is better
    const ratingScore = (driver.rating - 3) / 2;

    // Weighted combination
    const score = 0.6 * etaScore + 0.4 * ratingScore;

    return {
      ...driver,
      eta,
      score,
    };
  });

  // Sort by score descending
  return scored.sort((a, b) => b.score - a.score);
}
