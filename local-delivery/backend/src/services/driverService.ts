import { query, queryOne, execute } from '../utils/db.js';
import {
  updateDriverLocation as updateDriverLocationRedis,
  removeDriverLocation,
  findNearbyDrivers as findNearbyDriversRedis,
  getDriverLocationFromRedis,
  getDriverOrderCount,
} from '../utils/redis.js';
import { haversineDistance, calculateETA } from '../utils/geo.js';
import type {
  Driver,
  CreateDriverInput,
  DriverWithDistance,
  Location,
  MatchingScore,
} from '../types/index.js';

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

export async function getDriverById(id: string): Promise<Driver | null> {
  return queryOne<Driver>(`SELECT * FROM drivers WHERE id = $1`, [id]);
}

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

export async function updateDriverLocation(
  id: string,
  lat: number,
  lng: number
): Promise<void> {
  // Update in PostgreSQL
  await execute(
    `UPDATE drivers
     SET current_lat = $1, current_lng = $2, location_updated_at = NOW()
     WHERE id = $3`,
    [lat, lng, id]
  );

  // Update in Redis for real-time queries
  await updateDriverLocationRedis(id, lat, lng);

  // Log to history (sample every 10 seconds to reduce data volume)
  const historyKey = `driver:${id}:last_history`;
  const lastHistory = await getDriverLocationFromRedis(id);
  if (!lastHistory || Date.now() - lastHistory.updated_at > 10000) {
    await execute(
      `INSERT INTO driver_location_history (driver_id, lat, lng)
       VALUES ($1, $2, $3)`,
      [id, lat, lng]
    );
  }
}

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

export async function calculateDriverScore(
  driver: DriverWithDistance,
  maxDistance: number = 5
): Promise<MatchingScore> {
  // Get current order count
  const currentOrders = await getDriverOrderCount(driver.id);

  // Distance score (closer is better, normalized 0-1)
  const distanceScore = Math.max(0, 1 - driver.distance / maxDistance);

  // Rating score (normalized 0-1)
  const ratingScore = driver.rating / 5;

  // Acceptance rate (already 0-1)
  const acceptanceScore = driver.acceptance_rate;

  // Load balancing (prefer drivers with fewer orders)
  const loadScore = Math.max(0, 1 - currentOrders / 3);

  // Weighted combination
  const totalScore =
    distanceScore * 0.4 +
    ratingScore * 0.25 +
    acceptanceScore * 0.2 +
    loadScore * 0.15;

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

export async function updateDriverAcceptanceRate(id: string): Promise<void> {
  // Calculate acceptance rate from recent offers
  const result = await queryOne<{ rate: number }>(
    `SELECT
       CASE WHEN COUNT(*) = 0 THEN 1
       ELSE COUNT(*) FILTER (WHERE status = 'accepted')::DECIMAL / COUNT(*)
       END as rate
     FROM driver_offers
     WHERE driver_id = $1
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

export async function incrementDriverDeliveries(id: string): Promise<void> {
  await execute(
    `UPDATE drivers SET total_deliveries = total_deliveries + 1 WHERE id = $1`,
    [id]
  );
}
