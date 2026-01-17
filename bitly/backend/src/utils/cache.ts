import Redis from 'ioredis';
import { REDIS_CONFIG, CACHE_CONFIG } from '../config.js';

// Create Redis client
export const redis = new Redis({
  host: REDIS_CONFIG.host,
  port: REDIS_CONFIG.port,
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('connect', () => {
  console.log('Redis connected');
});

redis.on('error', (error) => {
  console.error('Redis error:', error);
});

// Cache operations for URL mappings
export const urlCache = {
  async get(shortCode: string): Promise<string | null> {
    return redis.get(`url:${shortCode}`);
  },

  async set(shortCode: string, longUrl: string, ttl?: number): Promise<void> {
    await redis.setex(`url:${shortCode}`, ttl || CACHE_CONFIG.urlTTL, longUrl);
  },

  async delete(shortCode: string): Promise<void> {
    await redis.del(`url:${shortCode}`);
  },

  async exists(shortCode: string): Promise<boolean> {
    const result = await redis.exists(`url:${shortCode}`);
    return result === 1;
  },
};

// Session cache operations
export const sessionCache = {
  async get(token: string): Promise<string | null> {
    return redis.get(`session:${token}`);
  },

  async set(token: string, userId: string, ttl?: number): Promise<void> {
    await redis.setex(`session:${token}`, ttl || CACHE_CONFIG.sessionTTL, userId);
  },

  async delete(token: string): Promise<void> {
    await redis.del(`session:${token}`);
  },
};

// Key pool cache for local server allocation
export const keyPoolCache = {
  async getKeys(): Promise<string[]> {
    return redis.lrange('local_key_pool', 0, -1);
  },

  async popKey(): Promise<string | null> {
    return redis.lpop('local_key_pool');
  },

  async addKeys(keys: string[]): Promise<void> {
    if (keys.length > 0) {
      await redis.rpush('local_key_pool', ...keys);
    }
  },

  async count(): Promise<number> {
    return redis.llen('local_key_pool');
  },
};

// Graceful shutdown
export async function closeRedis(): Promise<void> {
  await redis.quit();
  console.log('Redis connection closed');
}
