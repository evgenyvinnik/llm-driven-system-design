import Redis from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6379');

/**
 * Main Redis client for general operations (caching, geo-indexing, etc.).
 * Uses lazy connection to defer connecting until first use.
 */
export const redis = new Redis({
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

/**
 * Publisher client for Redis Pub/Sub operations.
 * Separate from main client because subscribed clients cannot publish.
 * Used to broadcast real-time updates (driver locations, order status changes).
 */
export const publisher = new Redis({
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

/**
 * Creates a new Redis subscriber client for Pub/Sub.
 * Each WebSocket connection needs its own subscriber to receive channel messages.
 * Redis requires dedicated connections for subscriptions.
 *
 * @returns A new Redis client configured for subscription use
 */
export function createSubscriber(): Redis {
  return new Redis({
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: 3,
  });
}

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

publisher.on('error', (err) => {
  console.error('Redis publisher connection error:', err);
});

/**
 * Initializes Redis connections for the main client and publisher.
 * Must be called during server startup before any Redis operations.
 *
 * @returns Promise that resolves when both connections are established
 */
export async function initRedis(): Promise<void> {
  await redis.connect();
  await publisher.connect();
}

/**
 * Redis key for the geospatial index storing all active driver locations.
 * Uses Redis GEO commands (GEOADD, GEORADIUS) for efficient proximity queries.
 */
export const DRIVERS_GEO_KEY = 'drivers:locations';

/**
 * Updates a driver's location in Redis for real-time tracking.
 * Performs three operations atomically via pipeline:
 * 1. Updates geo-index for proximity searches (GEOADD)
 * 2. Stores driver metadata hash for quick lookups
 * 3. Publishes location update for subscribed clients
 *
 * @param driverId - The unique identifier of the driver
 * @param lat - Current latitude in decimal degrees
 * @param lng - Current longitude in decimal degrees
 */
export async function updateDriverLocation(
  driverId: string,
  lat: number,
  lng: number
): Promise<void> {
  const pipeline = redis.pipeline();

  // GEOADD for spatial indexing
  pipeline.geoadd(DRIVERS_GEO_KEY, lng, lat, driverId);

  // Store driver metadata
  pipeline.hset(`driver:${driverId}`, {
    lat: lat.toString(),
    lng: lng.toString(),
    updated_at: Date.now().toString(),
  });

  // Publish location update
  pipeline.publish(
    `driver:${driverId}:location`,
    JSON.stringify({ lat, lng, timestamp: Date.now() })
  );

  await pipeline.exec();
}

/**
 * Removes a driver from the geo-index when they go offline.
 * Cleans up both the geo-index entry and the driver metadata hash.
 *
 * @param driverId - The unique identifier of the driver to remove
 */
export async function removeDriverLocation(driverId: string): Promise<void> {
  await redis.zrem(DRIVERS_GEO_KEY, driverId);
  await redis.del(`driver:${driverId}`);
}

/**
 * Finds drivers within a specified radius of a location.
 * Uses Redis GEORADIUS for sub-millisecond proximity queries.
 * Results are sorted by distance ascending (closest first).
 *
 * @param lat - Center latitude in decimal degrees
 * @param lng - Center longitude in decimal degrees
 * @param radiusKm - Search radius in kilometers
 * @param limit - Maximum number of drivers to return (default 10)
 * @returns Array of driver IDs with their distances in km
 */
export async function findNearbyDrivers(
  lat: number,
  lng: number,
  radiusKm: number,
  limit: number = 10
): Promise<{ id: string; distance: number }[]> {
  // GEORADIUS query - returns [member, distance] pairs
  const results = await redis.georadius(
    DRIVERS_GEO_KEY,
    lng,
    lat,
    radiusKm,
    'km',
    'WITHDIST',
    'ASC',
    'COUNT',
    limit
  );

  return results.map((result) => {
    const [id, distance] = result as [string, string];
    return {
      id,
      distance: parseFloat(distance),
    };
  });
}

/**
 * Retrieves a driver's cached location from Redis.
 * Faster than database queries for real-time tracking scenarios.
 *
 * @param driverId - The unique identifier of the driver
 * @returns Driver's location and last update timestamp, or null if not found
 */
export async function getDriverLocationFromRedis(
  driverId: string
): Promise<{ lat: number; lng: number; updated_at: number } | null> {
  const data = await redis.hgetall(`driver:${driverId}`);
  if (!data.lat || !data.lng) return null;

  return {
    lat: parseFloat(data.lat),
    lng: parseFloat(data.lng),
    updated_at: parseInt(data.updated_at || '0'),
  };
}

/**
 * Registers a WebSocket client for order tracking updates.
 * Adds the connection ID to a Redis set for the order.
 *
 * @param orderId - The order being tracked
 * @param connectionId - The WebSocket client's unique identifier
 */
export async function subscribeToOrderTracking(
  orderId: string,
  connectionId: string
): Promise<void> {
  await redis.sadd(`order:${orderId}:subscribers`, connectionId);
}

/**
 * Unregisters a WebSocket client from order tracking updates.
 * Removes the connection ID from the order's subscriber set.
 *
 * @param orderId - The order that was being tracked
 * @param connectionId - The WebSocket client's unique identifier
 */
export async function unsubscribeFromOrderTracking(
  orderId: string,
  connectionId: string
): Promise<void> {
  await redis.srem(`order:${orderId}:subscribers`, connectionId);
}

/**
 * Gets all WebSocket connection IDs subscribed to an order.
 * Used when broadcasting order updates to connected clients.
 *
 * @param orderId - The order to get subscribers for
 * @returns Array of WebSocket connection IDs
 */
export async function getOrderSubscribers(orderId: string): Promise<string[]> {
  return redis.smembers(`order:${orderId}:subscribers`);
}

/**
 * Adds an order to a driver's active orders set.
 * Tracks which orders a driver is currently handling for load balancing.
 *
 * @param driverId - The driver's unique identifier
 * @param orderId - The order being assigned to the driver
 */
export async function addDriverOrder(
  driverId: string,
  orderId: string
): Promise<void> {
  await redis.sadd(`driver:${driverId}:orders`, orderId);
}

/**
 * Removes an order from a driver's active orders set.
 * Called when an order is delivered or cancelled.
 *
 * @param driverId - The driver's unique identifier
 * @param orderId - The order being removed
 */
export async function removeDriverOrder(
  driverId: string,
  orderId: string
): Promise<void> {
  await redis.srem(`driver:${driverId}:orders`, orderId);
}

/**
 * Gets all active order IDs for a driver.
 *
 * @param driverId - The driver's unique identifier
 * @returns Array of order IDs the driver is currently handling
 */
export async function getDriverOrders(driverId: string): Promise<string[]> {
  return redis.smembers(`driver:${driverId}:orders`);
}

/**
 * Gets the count of active orders for a driver.
 * Used in driver matching to prefer drivers with fewer concurrent orders.
 *
 * @param driverId - The driver's unique identifier
 * @returns Number of orders the driver is currently handling
 */
export async function getDriverOrderCount(driverId: string): Promise<number> {
  return redis.scard(`driver:${driverId}:orders`);
}
