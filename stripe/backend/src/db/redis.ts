import { Redis } from 'ioredis';
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

redis.on('error', (err: Error) => {
  console.error('Redis error:', err.message);
});

// Idempotency response interface
export interface IdempotencyResponse {
  statusCode: number;
  body: unknown;
  requestPath: string;
  requestMethod: string;
}

// Idempotency key helpers
export async function getIdempotencyKey(
  merchantId: string,
  key: string
): Promise<IdempotencyResponse | null> {
  const cacheKey = `idempotency:${merchantId}:${key}`;
  const cached = await redis.get(cacheKey);
  return cached ? (JSON.parse(cached) as IdempotencyResponse) : null;
}

export async function setIdempotencyKey(
  merchantId: string,
  key: string,
  response: IdempotencyResponse,
  ttl: number = 86400
): Promise<void> {
  const cacheKey = `idempotency:${merchantId}:${key}`;
  await redis.setex(cacheKey, ttl, JSON.stringify(response));
}

export async function acquireIdempotencyLock(
  merchantId: string,
  key: string,
  ttl: number = 60
): Promise<boolean> {
  const lockKey = `idempotency:${merchantId}:${key}:lock`;
  const acquired = await redis.set(lockKey, '1', 'NX', 'EX', ttl);
  return acquired === 'OK';
}

export async function releaseIdempotencyLock(
  merchantId: string,
  key: string
): Promise<void> {
  const lockKey = `idempotency:${merchantId}:${key}:lock`;
  await redis.del(lockKey);
}

// Rate limiting helpers
export async function incrementRateLimit(
  key: string,
  windowSeconds: number = 60
): Promise<number> {
  const multi = redis.multi();
  multi.incr(key);
  multi.expire(key, windowSeconds);
  const results = await multi.exec();
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return results![0]![1] as number;
}

export async function getRateLimit(key: string): Promise<number> {
  const count = await redis.get(key);
  return parseInt(count || '0');
}

// Session/Cache helpers
export async function cacheGet<T = unknown>(key: string): Promise<T | null> {
  const value = await redis.get(key);
  return value ? (JSON.parse(value) as T) : null;
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttl: number = 3600
): Promise<void> {
  await redis.setex(key, ttl, JSON.stringify(value));
}

export async function cacheDel(key: string): Promise<void> {
  await redis.del(key);
}

export default redis;
