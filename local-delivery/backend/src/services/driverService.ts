import { query, queryOne, execute, withTransaction } from '../utils/db.js';
import {
  redis,
  updateDriverLocation as updateDriverLocationRedis,
  removeDriverLocation,
  findNearbyDrivers as findNearbyDriversRedis,
  getDriverOrderCount,
} from '../utils/redis.js';
import type {
  Driver,
  CreateDriverInput,
  DriverWithDistance,
  Location,
  MatchingScore,
} from '../types/index.js';

/**
 * Creates a new driver profile linked to an existing user account.
 * Called during driver registration after the user record is created.
 *
 * @param input - Driver-specific data including user ID and vehicle info
 * @returns The newly created driver profile
 * @throws Error if driver creation fails
 */
export async function createDriver(input: CreateDriverInput): Promise<Driver> {
  const result = await queryOne<Driver>(
    `INSERT INTO drivers (id, vehicle_type, license_plate)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.user_id, input.vehicle_type, input.license_plate || null]
  );

  if (!result) {
    throw new Error('Failed to create driver');
  }

  return result;
}

/**
 * Retrieves a driver profile by their unique identifier.
 *
 * @param id - The driver's UUID (same as their user ID)
 * @returns Driver profile or null if not found
 */
export async function getDriverById(id: string): Promise<Driver | null> {
  return queryOne<Driver>(`SELECT * FROM drivers WHERE id = $1`, [id]);
}

/**
 * Retrieves a driver profile with associated user information.
 * Combines driver and user tables for complete profile data.
 *
 * @param id - The driver's UUID
 * @returns Driver profile with name, email, and phone, or null if not found
 */
export async function getDriverWithUser(
  id: string
): Promise<(Driver & { name: string; email: string; phone: string | null }) | null> {
  return queryOne(
    `SELECT d.*, u.name, u.email, u.phone
     FROM drivers d
     JOIN users u ON d.id = u.id
     WHERE d.id = $1`,
    [id]
  );
}

/**
 * Updates a driver's availability status.
 * Transitions: offline -> available -> busy (with orders) -> available -> offline.
 * Going offline removes the driver from the geo-index.
 *
 * @param id - The driver's UUID
 * @param status - New status (offline, available, or busy)
 * @returns Updated driver profile or null if not found
 */
export async function updateDriverStatus(
  id: string,
  status: 'offline' | 'available' | 'busy'
): Promise<Driver | null> {
  const driver = await queryOne<Driver>(
    `UPDATE drivers SET status = $1 WHERE id = $2 RETURNING *`,
    [status, id]
  );

  if (driver && status === 'offline') {
    await removeDriverLocation(id);
  }

  return driver;
}

/**
 * Puts an offline courier online. A courier who is already available or busy
 * keeps their status, so going "online" again mid-delivery cannot make a busy
 * courier look free to the matcher.
 *
 * @param id - The driver's UUID
 * @returns The driver row, or null if no such driver
 */
export async function goOnline(id: string): Promise<Driver | null> {
  const updated = await queryOne<Driver>(
    `UPDATE drivers SET status = 'available' WHERE id = $1 AND status = 'offline' RETURNING *`,
    [id]
  );
  return updated ?? getDriverById(id);
}

/**
 * Result of a go-offline request.
 */
export type GoOfflineResult =
  | { status: 'offline'; driver: Driver }
  | { status: 'has_active_orders' }
  | { status: 'not_found' };

/**
 * Takes a courier offline unless they hold an active delivery. The check and
 * the update are one statement, and outstanding offers are withdrawn in the
 * same transaction, so an Accept racing this request either loses (offer
 * withdrawn) or wins (the active order then blocks going offline).
 *
 * @param id - The driver's UUID
 */
export async function goOffline(id: string): Promise<GoOfflineResult> {
  const driver = await withTransaction(async (client) => {
    const result = await client.query<Driver>(
      `UPDATE drivers SET status = 'offline'
       WHERE id = $1
         AND NOT EXISTS (
           SELECT 1 FROM orders
           WHERE driver_id = $1 AND status IN ('driver_assigned', 'picked_up', 'in_transit')
         )
       RETURNING *`,
      [id]
    );
    if (result.rows[0]) {
      await client.query(
        `UPDATE driver_offers SET status = 'expired', responded_at = NOW()
         WHERE driver_id = $1 AND status = 'pending'`,
        [id]
      );
    }
    return result.rows[0] ?? null;
  });

  if (driver) {
    await removeDriverLocation(id);
    return { status: 'offline', driver };
  }
  return (await getDriverById(id)) ? { status: 'has_active_orders' } : { status: 'not_found' };
}

/**
 * At most one durable location write per courier per interval. The live
 * position always goes to Redis; PostgreSQL gets a sample for the last-known
 * position and the location history.
 */
export const LOCATION_PERSIST_INTERVAL_MS = 10_000;

/**
 * Updates a driver's current location.
 * Hot path: Redis only (geo index, last-seen, pub/sub). Every
 * LOCATION_PERSIST_INTERVAL_MS the first ping in the window also writes
 * PostgreSQL: one statement updates the last-known position and appends a
 * history row. The window is a Redis SET NX PX gate, so it holds across API
 * instances. (Previously every ping wrote PostgreSQL, and the history sampling
 * compared against the timestamp it had just written, so history was never
 * recorded.)
 *
 * @param id - The driver's UUID
 * @param lat - Current latitude in decimal degrees
 * @param lng - Current longitude in decimal degrees
 * @param extras - Optional speed and heading from the device
 * @returns Whether this ping was also persisted to PostgreSQL
 */
export async function updateDriverLocation(
  id: string,
  lat: number,
  lng: number,
  extras: { speed?: number | null; heading?: number | null } = {}
): Promise<{ persisted: boolean }> {
  await updateDriverLocationRedis(id, lat, lng);

  const gate = await redis.set(`driver:${id}:persist_gate`, '1', 'PX', LOCATION_PERSIST_INTERVAL_MS, 'NX');
  if (gate !== 'OK') {
    return { persisted: false };
  }

  await execute(
    `WITH moved AS (
       UPDATE drivers
       SET current_lat = $2, current_lng = $3, location_updated_at = NOW()
       WHERE id = $1
       RETURNING id
     )
     INSERT INTO driver_location_history (driver_id, lat, lng, speed, heading)
     SELECT id, $2, $3, $4, $5 FROM moved`,
    [id, lat, lng, extras.speed ?? null, extras.heading ?? null]
  );
  return { persisted: true };
}

/**
 * Finds available drivers near a location for order assignment.
 * Uses the Redis geo-index for the proximity search (fresh pings only), then
 * enriches with PostgreSQL. A courier must be both reachable (pinged within
 * LOCATION_STALE_MS, tracked in Redis) and willing (status 'available' in
 * PostgreSQL) to be returned.
 *
 * @param location - The pickup location (usually merchant)
 * @param radiusKm - Search radius in kilometers (default 5)
 * @param limit - Maximum drivers to return (default 10)
 * @returns Array of drivers with distance, sorted by proximity
 */
export async function findNearbyDrivers(
  location: Location,
  radiusKm: number = 5,
  limit: number = 10
): Promise<DriverWithDistance[]> {
  // Get nearby driver IDs from Redis
  const nearbyIds = await findNearbyDriversRedis(location.lat, location.lng, radiusKm, limit * 2);

  if (nearbyIds.length === 0) {
    return [];
  }

  // Get driver details from PostgreSQL
  const drivers = await query<Driver & { name: string }>(
    `SELECT d.*, u.name
     FROM drivers d
     JOIN users u ON d.id = u.id
     WHERE d.id = ANY($1) AND d.status = 'available'`,
    [nearbyIds.map((d) => d.id)]
  );

  // Merge distance data and sort
  const driversWithDistance: DriverWithDistance[] = drivers.map((driver) => {
    const nearbyInfo = nearbyIds.find((n) => n.id === driver.id);
    return {
      ...driver,
      distance: nearbyInfo?.distance || 0,
    };
  });

  return driversWithDistance
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit);
}

/** Weights of the matching score; they sum to 1. */
export const SCORE_WEIGHTS = {
  distance: 0.4,
  rating: 0.25,
  acceptanceRate: 0.2,
  load: 0.15,
} as const;

/**
 * Pure matching score in [0, 1] for one candidate.
 * Factors: distance (40%), rating (25%), acceptance rate (20%), current load (15%).
 * Numeric columns arrive from pg as strings, so every input is coerced.
 *
 * @param driver - Candidate with distance (km), rating (0-5) and acceptance rate (0-1)
 * @param currentOrders - Orders the courier is carrying now
 * @param maxDistance - Distance at which the distance score reaches 0 (km)
 */
export function scoreDriver(
  driver: Pick<DriverWithDistance, 'id' | 'distance' | 'rating' | 'acceptance_rate'>,
  currentOrders: number,
  maxDistance: number = 5
): MatchingScore {
  const distanceScore = Math.max(0, 1 - Number(driver.distance) / maxDistance);
  const ratingScore = Number(driver.rating) / 5;
  const acceptanceScore = Number(driver.acceptance_rate);
  const loadScore = Math.max(0, 1 - currentOrders / 3);

  const totalScore =
    distanceScore * SCORE_WEIGHTS.distance +
    ratingScore * SCORE_WEIGHTS.rating +
    acceptanceScore * SCORE_WEIGHTS.acceptanceRate +
    loadScore * SCORE_WEIGHTS.load;

  return {
    driver_id: driver.id,
    total_score: totalScore,
    factors: {
      distance: distanceScore,
      rating: ratingScore,
      acceptance_rate: acceptanceScore,
      current_orders: currentOrders,
    },
  };
}

/**
 * Calculates a matching score for a driver, reading their current load from Redis.
 *
 * @param driver - Driver with distance already calculated
 * @param maxDistance - Maximum expected distance for normalization (default 5km)
 * @returns Matching score with breakdown of individual factors
 */
export async function calculateDriverScore(
  driver: DriverWithDistance,
  maxDistance: number = 5
): Promise<MatchingScore> {
  const currentOrders = await getDriverOrderCount(driver.id);
  return scoreDriver(driver, currentOrders, maxDistance);
}

/**
 * Finds the best available driver for an order using the scoring algorithm.
 * Filters out excluded drivers (e.g., those who rejected the offer).
 * Returns the highest-scoring available driver.
 *
 * @param pickupLocation - Merchant location for the order
 * @param excludeDriverIds - Set of driver IDs to skip (previously rejected)
 * @returns Best matching driver or null if none available
 */
export async function findBestDriver(
  pickupLocation: Location,
  excludeDriverIds: Set<string> = new Set()
): Promise<DriverWithDistance | null> {
  const nearbyDrivers = await findNearbyDrivers(pickupLocation, 5, 20);

  // Filter out excluded drivers
  const availableDrivers = nearbyDrivers.filter(
    (d) => !excludeDriverIds.has(d.id)
  );

  if (availableDrivers.length === 0) {
    return null;
  }

  // Score each driver
  const scores = await Promise.all(
    availableDrivers.map(async (driver) => ({
      driver,
      score: await calculateDriverScore(driver),
    }))
  );

  // Sort by score and return best
  scores.sort((a, b) => b.score.total_score - a.score.total_score);

  return scores[0]?.driver || null;
}

/**
 * Recalculates a driver's average rating from all their ratings.
 * Called after a customer submits a new rating for a completed delivery.
 *
 * @param id - The driver's UUID
 */
export async function updateDriverRating(id: string): Promise<void> {
  // Calculate average rating from all ratings
  const result = await queryOne<{ avg: number }>(
    `SELECT AVG(r.rating)::DECIMAL(3,2) as avg
     FROM ratings r
     WHERE r.rated_user_id = $1`,
    [id]
  );

  if (result?.avg) {
    await execute(`UPDATE drivers SET rating = $1 WHERE id = $2`, [result.avg, id]);
  }
}

/**
 * Recalculates a driver's acceptance rate from recent answered offers.
 * Uses a 7-day rolling window to reflect current behavior; offers still
 * pending are not counted. Called by the matching loop after every offer
 * settles, so the 20% acceptance factor of the score reflects real behavior.
 *
 * @param id - The driver's UUID
 */
export async function updateDriverAcceptanceRate(id: string): Promise<void> {
  // Calculate acceptance rate from recent offers
  const result = await queryOne<{ rate: number }>(
    `SELECT
       CASE WHEN COUNT(*) = 0 THEN 1
       ELSE COUNT(*) FILTER (WHERE status = 'accepted')::DECIMAL / COUNT(*)
       END as rate
     FROM driver_offers
     WHERE driver_id = $1
     AND status <> 'pending'
     AND offered_at > NOW() - INTERVAL '7 days'`,
    [id]
  );

  if (result) {
    await execute(`UPDATE drivers SET acceptance_rate = $1 WHERE id = $2`, [
      result.rate,
      id,
    ]);
  }
}

/**
 * Retrieves comprehensive statistics for a driver's profile page.
 * Combines database stats with real-time Redis data.
 *
 * @param id - The driver's UUID
 * @returns Driver statistics including rating, deliveries, acceptance rate, and current orders
 */
export async function getDriverStats(id: string): Promise<{
  rating: number;
  total_deliveries: number;
  acceptance_rate: number;
  current_orders: number;
}> {
  const driver = await getDriverById(id);
  const currentOrders = await getDriverOrderCount(id);

  return {
    rating: driver?.rating || 5,
    total_deliveries: driver?.total_deliveries || 0,
    acceptance_rate: driver?.acceptance_rate || 1,
    current_orders: currentOrders,
  };
}

/**
 * Increments a driver's total delivery count.
 * Called when an order is successfully delivered.
 *
 * @param id - The driver's UUID
 */
export async function incrementDriverDeliveries(id: string): Promise<void> {
  await execute(
    `UPDATE drivers SET total_deliveries = total_deliveries + 1 WHERE id = $1`,
    [id]
  );
}
