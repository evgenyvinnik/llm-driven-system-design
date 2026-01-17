// Redis client singleton

import Redis from 'ioredis';
import { config } from '../config/index.js';

let redisClient: Redis | null = null;

export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      retryStrategy: (times) => {
        if (times > 3) {
          console.error('Redis connection failed after 3 retries');
          return null;
        }
        return Math.min(times * 100, 3000);
      },
      maxRetriesPerRequest: 3,
    });

    redisClient.on('connect', () => {
      console.log('Connected to Redis');
    });

    redisClient.on('error', (err) => {
      console.error('Redis error:', err.message);
    });

    redisClient.on('close', () => {
      console.log('Redis connection closed');
    });
  }

  return redisClient;
}

export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}

// Metrics tracking in Redis
export async function recordMetric(
  redis: Redis,
  type: 'allowed' | 'denied',
  latencyMs: number
): Promise<void> {
  const now = Date.now();
  const minute = Math.floor(now / 60000);
  const key = `metrics:${minute}`;

  const pipeline = redis.pipeline();
  pipeline.hincrby(key, 'total', 1);
  pipeline.hincrby(key, type, 1);
  pipeline.hincrbyfloat(key, 'latency_sum', latencyMs);

  // Store latency for percentile calculation
  pipeline.lpush(`metrics:latencies:${minute}`, latencyMs);
  pipeline.ltrim(`metrics:latencies:${minute}`, 0, 999);

  // Keep metrics for 1 hour
  pipeline.expire(key, 3600);
  pipeline.expire(`metrics:latencies:${minute}`, 3600);

  await pipeline.exec();
}

export async function getMetrics(redis: Redis): Promise<{
  totalRequests: number;
  allowedRequests: number;
  deniedRequests: number;
  averageLatencyMs: number;
  p99LatencyMs: number;
  activeIdentifiers: number;
}> {
  const now = Date.now();
  const currentMinute = Math.floor(now / 60000);

  // Aggregate last 5 minutes
  let totalRequests = 0;
  let allowedRequests = 0;
  let deniedRequests = 0;
  let latencySum = 0;
  const allLatencies: number[] = [];

  const pipeline = redis.pipeline();
  for (let i = 0; i < 5; i++) {
    const minute = currentMinute - i;
    pipeline.hgetall(`metrics:${minute}`);
    pipeline.lrange(`metrics:latencies:${minute}`, 0, -1);
  }

  const results = await pipeline.exec();
  if (results) {
    for (let i = 0; i < 5; i++) {
      const metrics = results[i * 2]?.[1] as Record<string, string> | null;
      const latencies = results[i * 2 + 1]?.[1] as string[] | null;

      if (metrics) {
        totalRequests += parseInt(metrics.total || '0', 10);
        allowedRequests += parseInt(metrics.allowed || '0', 10);
        deniedRequests += parseInt(metrics.denied || '0', 10);
        latencySum += parseFloat(metrics.latency_sum || '0');
      }

      if (latencies) {
        allLatencies.push(...latencies.map(Number));
      }
    }
  }

  // Calculate p99
  allLatencies.sort((a, b) => a - b);
  const p99Index = Math.floor(allLatencies.length * 0.99);
  const p99LatencyMs = allLatencies[p99Index] || 0;

  // Count active identifiers (approximate by counting keys)
  const keys = await redis.keys('ratelimit:*');
  const activeIdentifiers = keys.length;

  return {
    totalRequests,
    allowedRequests,
    deniedRequests,
    averageLatencyMs: totalRequests > 0 ? latencySum / totalRequests : 0,
    p99LatencyMs,
    activeIdentifiers,
  };
}
