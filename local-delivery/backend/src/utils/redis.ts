import Redis from 'ioredis';

const redisHost = process.env.REDIS_HOST || 'localhost';
const redisPort = parseInt(process.env.REDIS_PORT || '6379');

// Main Redis client
export const redis = new Redis({
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// Publisher client for Pub/Sub
export const publisher = new Redis({
  host: redisHost,
  port: redisPort,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// Create subscriber client - separate connection for subscriptions
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

// Initialize connections
export async function initRedis(): Promise<void> {
  await redis.connect();
  await publisher.connect();
}

// Geo operations for driver locations
export const DRIVERS_GEO_KEY = 'drivers:locations';

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

export async function removeDriverLocation(driverId: string): Promise<void> {
  await redis.zrem(DRIVERS_GEO_KEY, driverId);
  await redis.del(`driver:${driverId}`);
}

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

// Order tracking subscriptions
export async function subscribeToOrderTracking(
  orderId: string,
  connectionId: string
): Promise<void> {
  await redis.sadd(`order:${orderId}:subscribers`, connectionId);
}

export async function unsubscribeFromOrderTracking(
  orderId: string,
  connectionId: string
): Promise<void> {
  await redis.srem(`order:${orderId}:subscribers`, connectionId);
}

export async function getOrderSubscribers(orderId: string): Promise<string[]> {
  return redis.smembers(`order:${orderId}:subscribers`);
}

// Driver active orders
export async function addDriverOrder(
  driverId: string,
  orderId: string
): Promise<void> {
  await redis.sadd(`driver:${driverId}:orders`, orderId);
}

export async function removeDriverOrder(
  driverId: string,
  orderId: string
): Promise<void> {
  await redis.srem(`driver:${driverId}:orders`, orderId);
}

export async function getDriverOrders(driverId: string): Promise<string[]> {
  return redis.smembers(`driver:${driverId}:orders`);
}

export async function getDriverOrderCount(driverId: string): Promise<number> {
  return redis.scard(`driver:${driverId}:orders`);
}
