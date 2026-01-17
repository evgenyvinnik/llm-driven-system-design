import Redis from 'ioredis';
import dotenv from 'dotenv';

dotenv.config();

const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableReadyCheck: true,
  lazyConnect: true,
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

redis.on('error', (err) => {
  console.error('Redis error:', err.message);
});

// Idempotency key helpers
export async function getIdempotencyKey(merchantId, key) {
  const cacheKey = `idempotency:${merchantId}:${key}`;
  const cached = await redis.get(cacheKey);
  return cached ? JSON.parse(cached) : null;
}

export async function setIdempotencyKey(merchantId, key, response, ttl = 86400) {
  const cacheKey = `idempotency:${merchantId}:${key}`;
  await redis.setex(cacheKey, ttl, JSON.stringify(response));
}

export async function acquireIdempotencyLock(merchantId, key, ttl = 60) {
  const lockKey = `idempotency:${merchantId}:${key}:lock`;
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', ttl);
  return acquired === 'OK';
}

export async function releaseIdempotencyLock(merchantId, key) {
  const lockKey = `idempotency:${merchantId}:${key}:lock`;
  await redis.del(lockKey);
}

// Rate limiting helpers
export async function incrementRateLimit(key, windowSeconds = 60) {
  const multi = redis.multi();
  multi.incr(key);
  multi.expire(key, windowSeconds);
  const [count] = await multi.exec();
  return count[1];
}

export async function getRateLimit(key) {
  const count = await redis.get(key);
  return parseInt(count || '0');
}

// Session/Cache helpers
export async function cacheGet(key) {
  const value = await redis.get(key);
  return value ? JSON.parse(value) : null;
}

export async function cacheSet(key, value, ttl = 3600) {
  await redis.setex(key, ttl, JSON.stringify(value));
}

export async function cacheDel(key) {
  await redis.del(key);
}

export default redis;
