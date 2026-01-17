import Redis from 'ioredis';

/**
 * Redis client for session storage and real-time pub/sub notifications.
 * Used by express-session for distributed session management and by
 * NotificationService to broadcast notifications to connected clients.
 * Includes exponential backoff retry strategy for connection resilience.
 */
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

redis.on('error', (err) => {
  console.error('Redis connection error:', err);
});

redis.on('connect', () => {
  console.log('Connected to Redis');
});

export default redis;
