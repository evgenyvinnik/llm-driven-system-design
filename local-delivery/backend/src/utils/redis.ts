import Redis from 'ioredis';

const RedisClient = Redis.default ?? Redis;

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6379');

/**
 * Main Redis client for general operations (caching, geo-indexing, etc.).
 * Uses lazy connection to defer connecting until first use.
 */
export const redis = new RedisClient({
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
export const publisher = new RedisClient({
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

/**
 * Creates a new Redis subscriber client for Pub/Sub.
 * A connection in subscribe mode cannot run other commands, so it needs its own
 * client. The WebSocket layer creates exactly one per process and fans messages
 * out to local sockets (see websocket/channelRegistry.ts).
 *
 * @returns A new Redis client configured for subscription use
 */
export function createSubscriber(): InstanceType<typeof RedisClient> {
  return new RedisClient({
    host: redisHost,
    port: redisPort,
    maxRetriesPerRequest: 3,
  });
}

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

publisher.on('error', (err: Error) => {
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
 * Queried with GEOSEARCH (GEORADIUS is deprecated since Redis 6.2).
 */
export const DRIVERS_GEO_KEY = 'drivers:locations';

/**
 * Sorted set of driver id -> epoch ms of their last location ping.
 * A GEO set's score is the geohash, so liveness needs its own sorted set.
 */
export const DRIVERS_LAST_SEEN_KEY = 'drivers:last_seen';

/**
 * A courier whose last ping is older than this is not offered orders.
 * Courier apps send a heartbeat every 10 s even when stationary, so 30 s is
 * three missed heartbeats. Overridable for demos via LOCATION_STALE_MS.
 */
export const LOCATION_STALE_MS = parseInt(process.env.LOCATION_STALE_MS || '30000');

/**
 * Entries older than this are removed from the geo index entirely by
 * pruneStaleDrivers(); they re-enter on their next ping.
 */
export const LOCATION_PRUNE_AFTER_MS = 2 * 60 * 1000;

/** The per-driver metadata hash expires if a courier vanishes. */
const DRIVER_HASH_TTL_SECONDS = 10 * 60;

/**
 * Runs a pipeline and surfaces the first command error (ioredis reports
 * per-command errors in the result array instead of rejecting).
 */
async function execPipeline(pipeline: ReturnType<typeof redis.pipeline>): Promise<void> {
  const results = await pipeline.exec();
  const failed = results?.find(([error]) => error);
  if (failed?.[0]) {
    throw failed[0];
  }
}

/**
 * Updates a driver's location in Redis for real-time tracking.
 * One pipeline (one round trip):
 * 1. GEOADD for proximity searches
 * 2. ZADD last-seen time, which is what makes the entry "fresh"
 * 3. Metadata hash with a TTL, for the latest position by id
 * 4. PUBLISH to the driver's location channel for customers tracking an order
 *
 * @param driverId - The unique identifier of the driver
 * @param lat - Current latitude in decimal degrees
 * @param lng - Current longitude in decimal degrees
 * @param now - Ping time in epoch ms (injectable for tests)
 */
export async function updateDriverLocation(
  driverId: string,
  lat: number,
  lng: number,
  now: number = Date.now()
): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.geoadd(DRIVERS_GEO_KEY, lng, lat, driverId);
  pipeline.zadd(DRIVERS_LAST_SEEN_KEY, now, driverId);
  pipeline.hset(`driver:${driverId}`, {
    lat: lat.toString(),
    lng: lng.toString(),
    updated_at: now.toString(),
  });
  pipeline.expire(`driver:${driverId}`, DRIVER_HASH_TTL_SECONDS);
  pipeline.publish(`driver:${driverId}:location`, JSON.stringify({ lat, lng, timestamp: now }));
  await execPipeline(pipeline);
}

/**
 * Removes a driver from the geo-index when they go offline.
 * Cleans up the geo entry, the last-seen entry and the metadata hash.
 *
 * @param driverId - The unique identifier of the driver to remove
 */
export async function removeDriverLocation(driverId: string): Promise<void> {
  const pipeline = redis.pipeline();
  pipeline.zrem(DRIVERS_GEO_KEY, driverId);
  pipeline.zrem(DRIVERS_LAST_SEEN_KEY, driverId);
  pipeline.del(`driver:${driverId}`);
  await execPipeline(pipeline);
}

/**
 * Keeps only candidates whose last ping is recent enough.
 * Pure function: `lastSeen[i]` is the ZMSCORE result for `candidates[i]`.
 *
 * @param candidates - Drivers returned by the geo search
 * @param lastSeen - Last ping time per candidate (null if unknown)
 * @param now - Current epoch ms
 * @param staleMs - Maximum age of the last ping
 */
export function filterFreshDrivers<T extends { id: string }>(
  candidates: T[],
  lastSeen: (string | number | null)[],
  now: number,
  staleMs: number
): T[] {
  return candidates.filter((_candidate, index) => {
    const seen = lastSeen[index];
    return seen !== null && seen !== undefined && now - Number(seen) <= staleMs;
  });
}

/**
 * Finds drivers within a radius whose location is fresh.
 * GEOSEARCH returns the nearest members first; ZMSCORE then fetches all their
 * last-seen times in one call, and stale members (phone died, app killed) are
 * dropped so matching never offers an order to a ghost and waits 30 s for it.
 *
 * @param lat - Center latitude in decimal degrees
 * @param lng - Center longitude in decimal degrees
 * @param radiusKm - Search radius in kilometers
 * @param limit - Maximum number of drivers to return (default 10)
 * @param now - Current epoch ms (injectable for tests)
 * @returns Driver ids with their distances in km, nearest first
 */
export async function findNearbyDrivers(
  lat: number,
  lng: number,
  radiusKm: number,
  limit: number = 10,
  now: number = Date.now()
): Promise<{ id: string; distance: number }[]> {
  const results = (await redis.call(
    'GEOSEARCH',
    DRIVERS_GEO_KEY,
    'FROMLONLAT',
    lng,
    lat,
    'BYRADIUS',
    radiusKm,
    'km',
    'ASC',
    'COUNT',
    limit,
    'WITHDIST'
  )) as [string, string][];

  if (results.length === 0) {
    return [];
  }

  const candidates = results.map(([id, distance]) => ({ id, distance: parseFloat(distance) }));
  const lastSeen = await redis.zmscore(DRIVERS_LAST_SEEN_KEY, ...candidates.map((c) => c.id));
  return filterFreshDrivers(candidates, lastSeen, now, LOCATION_STALE_MS);
}

/**
 * Atomically removes members whose last ping is older than the cutoff from
 * both the geo index and the last-seen set. A Lua script, so a driver who pings
 * between the range read and the removal is not removed by mistake.
 */
const PRUNE_STALE_SCRIPT = `
local stale = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', ARGV[1])
for _, id in ipairs(stale) do
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZREM', KEYS[2], id)
end
return stale
`;

/**
 * Drops couriers who stopped pinging from the geo index.
 *
 * @param maxAgeMs - Remove entries whose last ping is older than this
 * @param now - Current epoch ms (injectable for tests)
 * @returns Ids of the removed drivers
 */
export async function pruneStaleDrivers(
  maxAgeMs: number = LOCATION_PRUNE_AFTER_MS,
  now: number = Date.now()
): Promise<string[]> {
  return (await redis.eval(
    PRUNE_STALE_SCRIPT,
    2,
    DRIVERS_GEO_KEY,
    DRIVERS_LAST_SEEN_KEY,
    String(now - maxAgeMs)
  )) as string[];
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
 * Adds an order to a driver's active orders set.
 * A cache of the courier's load used by the matching score; PostgreSQL is the
 * source of truth for which orders a courier holds.
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
 * Gets the count of active orders for a driver.
 * Used in driver matching to prefer drivers with fewer concurrent orders.
 *
 * @param driverId - The driver's unique identifier
 * @returns Number of orders the driver is currently handling
 */
export async function getDriverOrderCount(driverId: string): Promise<number> {
  return redis.scard(`driver:${driverId}:orders`);
}
