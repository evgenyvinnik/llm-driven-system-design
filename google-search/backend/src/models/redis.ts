import Redis from 'ioredis';
import { config } from '../config/index.js';

const redis = new Redis(config.redis.url, {
  retryStrategy: (times: number) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
});

redis.on('error', (err: Error) => {
  console.error('Redis connection error:', err.message);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

// Cache keys
export const CACHE_KEYS = {
  QUERY_RESULT: (query: string, page: number): string => `search:${query}:${page}`,
  AUTOCOMPLETE: (prefix: string): string => `autocomplete:${prefix}`,
  ROBOTS_TXT: (domain: string): string => `robots:${domain}`,
  HOST_LAST_FETCH: (host: string): string => `host_fetch:${host}`,
  PAGE_RANK: (urlId: number): string => `pagerank:${urlId}`,
};

// Cache TTL in seconds
export const CACHE_TTL = {
  QUERY_RESULT: 300, // 5 minutes
  AUTOCOMPLETE: 600, // 10 minutes
  ROBOTS_TXT: 86400, // 24 hours
  HOST_LAST_FETCH: 10, // 10 seconds
  PAGE_RANK: 3600, // 1 hour
};

export { redis };
