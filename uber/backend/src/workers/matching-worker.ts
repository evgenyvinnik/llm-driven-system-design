/**
 * Matching worker for Uber
 * Processes matching.requests queue to match riders with drivers.
 */
import { connectRabbitMQ, closeRabbitMQ, consumeQueue, publishToExchange, QUEUES, EXCHANGES } from '../utils/queue.js';
import { createLogger } from '../utils/logger.js';
import pool, { query } from '../utils/db.js';

const logger = createLogger('matching-worker');

interface MatchingRequest {
  requestId: string;
  riderId: string;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  rideType: string;
  timestamp: string;
}

interface DriverCandidate {
  id: string;
  name: string;
  lat: number;
  lng: number;
  rating: number;
  distance: number;
  eta: number;
}

/**
 * Calculate distance between two points (Haversine formula).
 */
function calculateDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371; // Earth's radius in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/**
 * Find available drivers near pickup location.
 */
async function findNearbyDrivers(lat: number, lng: number, radiusKm: number = 5): Promise<DriverCandidate[]> {
  // In production, would use Redis GEORADIUS
  // Use bounding box filter instead of PostGIS (not available in dev)
  const latDelta = radiusKm / 111.0; // ~111 km per degree latitude
  const lngDelta = radiusKm / (111.0 * Math.cos(lat * Math.PI / 180));

  const result = await query<{
    user_id: string;
    name: string;
    current_lat: number;
    current_lng: number;
    rating: number;
  }>(`
    SELECT d.user_id, u.name, d.current_lat, d.current_lng, u.rating
    FROM drivers d
    JOIN users u ON d.user_id = u.id
    WHERE d.is_available = TRUE
      AND d.is_online = TRUE
      AND d.current_lat IS NOT NULL
      AND d.current_lng IS NOT NULL
      AND d.current_lat BETWEEN $1 AND $2
      AND d.current_lng BETWEEN $3 AND $4
    LIMIT 20
  `, [lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta]);

  return result.rows
    .map(row => {
      const distance = calculateDistance(lat, lng, row.current_lat, row.current_lng);
      return {
        id: row.user_id,
        name: row.name,
        lat: row.current_lat,
        lng: row.current_lng,
        rating: Number(row.rating),
        distance,
        eta: Math.ceil(distance / 30 * 60), // Assume 30 km/h average speed
      };
    })
    .filter(d => d.distance <= radiusKm)
    .slice(0, 10);
}

/**
 * Score and rank drivers for matching.
 */
function scoreDrivers(drivers: DriverCandidate[]): DriverCandidate[] {
  return drivers
    .map(driver => ({
      ...driver,
      score: (driver.rating * 0.3) + ((10 - driver.eta) * 0.7), // Weighted score
    }))
    .sort((a, b) => (b as any).score - (a as any).score);
}

/**
 * Process matching requests.
 */
async function handleMatchingRequest(request: MatchingRequest): Promise<void> {
  const { requestId, riderId, pickupLat, pickupLng, dropoffLat, dropoffLng, rideType } = request;

  logger.info({ requestId, riderId }, 'Processing matching request');

  // Find nearby available drivers
  const drivers = await findNearbyDrivers(pickupLat, pickupLng);

  if (drivers.length === 0) {
    logger.warn({ requestId, riderId }, 'No drivers available');

    // Publish no-drivers event
    await publishToExchange(EXCHANGES.RIDE_EVENTS, '', {
      eventId: crypto.randomUUID(),
      eventType: 'matching.no_drivers',
      requestId,
      riderId,
      timestamp: new Date().toISOString(),
    });

    return;
  }

  // Score and select best driver
  const rankedDrivers = scoreDrivers(drivers);
  const selectedDriver = rankedDrivers[0];

  logger.info({
    requestId,
    driverId: selectedDriver.id,
    eta: selectedDriver.eta,
    distance: selectedDriver.distance
  }, 'Driver matched');

  // Create ride record
  const rideResult = await query<{ id: string }>(`
    INSERT INTO rides (rider_id, driver_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng, vehicle_type, status, requested_at, matched_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'matched', NOW(), NOW())
    RETURNING id
  `, [riderId, selectedDriver.id, pickupLat, pickupLng, dropoffLat, dropoffLng, rideType]);

  const rideId = rideResult.rows[0].id;

  // Update driver status
  await query(`
    UPDATE drivers SET is_available = FALSE, updated_at = NOW() WHERE user_id = $1
  `, [selectedDriver.id]);

  // Publish match event
  await publishToExchange(EXCHANGES.RIDE_EVENTS, '', {
    eventId: crypto.randomUUID(),
    eventType: 'ride.matched',
    rideId,
    requestId,
    riderId,
    driver: {
      id: selectedDriver.id,
      name: selectedDriver.name,
      rating: selectedDriver.rating,
      eta: selectedDriver.eta,
    },
    timestamp: new Date().toISOString(),
  });

  logger.info({ requestId, rideId, driverId: selectedDriver.id }, 'Matching completed');
}

/**
 * Main worker entry point.
 */
async function main(): Promise<void> {
  logger.info('Starting Uber matching worker...');

  try {
    await connectRabbitMQ();

    await consumeQueue<MatchingRequest>(QUEUES.MATCHING_REQUESTS, async (content, msg) => {
      await handleMatchingRequest(content);
    }, { maxRetries: 3 });

    logger.info('Uber matching worker started, waiting for messages...');

    const shutdown = async () => {
      logger.info('Shutting down matching worker...');
      await closeRabbitMQ();
      await pool.end();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) {
    logger.error({ error }, 'Failed to start matching worker');
    process.exit(1);
  }
}

main();
