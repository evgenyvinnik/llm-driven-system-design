import Redis from 'ioredis';

/**
 * Redis client instance for the Apple Pay backend.
 * Used for session management, token caching, and Secure Element simulation.
 * Provides fast in-memory storage for frequently accessed data like:
 * - User sessions (with 1-hour TTL)
 * - Payment token references (for quick token lookups)
 * - Biometric session state (with 5-minute TTL)
 * - Simulated Secure Element data
 */
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

export default redis;
