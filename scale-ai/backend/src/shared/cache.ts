import Redis from 'ioredis'

// Redis configuration from environment
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379'

export const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => {
    if (times > 3) {
      console.error('Redis connection failed after 3 retries')
      return null // Stop retrying
    }
    return Math.min(times * 100, 3000)
  },
})

redis.on('connect', () => {
  console.log('Connected to Redis')
})

redis.on('error', (err) => {
  console.error('Redis error:', err.message)
})

// Cache helper functions
export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const data = await redis.get(key)
    if (!data) return null
    return JSON.parse(data) as T
  } catch (err) {
    console.error('Cache get error:', err)
    return null
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttlSeconds = 60
): Promise<void> {
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(value))
  } catch (err) {
    console.error('Cache set error:', err)
  }
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    await redis.del(key)
  } catch (err) {
    console.error('Cache delete error:', err)
  }
}

export async function cacheDeletePattern(pattern: string): Promise<void> {
  try {
    const keys = await redis.keys(pattern)
    if (keys.length > 0) {
      await redis.del(...keys)
    }
  } catch (err) {
    console.error('Cache delete pattern error:', err)
  }
}

// Cache key generators
export const CacheKeys = {
  adminStats: () => 'admin:stats',
  shapes: () => 'shapes:all',
  userStats: (sessionId: string) => `user:stats:${sessionId}`,
  drawing: (id: string) => `drawing:${id}`,
}
