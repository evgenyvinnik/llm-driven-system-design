/**
 * @fileoverview Redis client management with circuit breaker and fallback.
 *
 * Provides a resilient Redis client for the rate limiter service, including:
 * - Circuit breaker protection to prevent cascading failures
 * - Graceful degradation with configurable fail-open/fail-closed behavior
 * - Structured logging for observability
 * - Prometheus metrics for monitoring
 * - Helper functions for rate limit metrics recording
 */

import Redis from 'ioredis';
import CircuitBreaker from 'opossum';
import { config } from '../config/index.js';
import { logger, prometheusMetrics, createCircuitBreaker } from '../shared/index.js';

/** Singleton Redis client instance */
let redisClient: Redis | null = null;

/** Circuit breaker for Redis operations */
let redisCircuitBreaker: CircuitBreaker<unknown[], unknown> | null = null;

/** Counter for fallback activations (for throttled logging) */
let fallbackCounter = 0;

/**
 * Redis client status for health checks and monitoring.
 */
export interface RedisStatus {
  connected: boolean;
  circuitBreakerState: 'open' | 'closed' | 'half-open';
  lastError?: string;
  pingMs?: number;
}

/**
 * Get the singleton Redis client instance.
 * Creates and configures the client on first call, returns existing instance thereafter.
 * The client includes automatic retry logic and comprehensive event handlers.
 *
 * @returns Configured Redis client instance
 */
export function getRedisClient(): Redis {
  if (!redisClient) {
    redisClient = new Redis({
      host: config.redis.host,
      port: config.redis.port,
      password: config.redis.password,
      db: config.redis.db,
      connectTimeout: config.redis.connectTimeout,
      commandTimeout: config.redis.commandTimeout,
      maxRetriesPerRequest: config.redis.maxRetriesPerRequest,
      retryStrategy: (times) => {
        if (times > 3) {
          logger.error({ retries: times }, 'Redis connection failed after maximum retries');
          return null;
        }
        const delay = Math.min(times * 100, 3000);
        logger.warn({ retries: times, delayMs: delay }, 'Redis retry scheduled');
        return delay;
      },
      lazyConnect: false,
    });

    redisClient.on('connect', () => {
      logger.info(
        { host: config.redis.host, port: config.redis.port },
        'Connected to Redis'
      );
      prometheusMetrics.setRedisConnected(true);
    });

    redisClient.on('ready', () => {
      logger.info('Redis client ready for commands');
    });

    redisClient.on('error', (err) => {
      logger.error({ error: err.message }, 'Redis error');
      prometheusMetrics.setRedisConnected(false);
    });

    redisClient.on('close', () => {
      logger.warn('Redis connection closed');
      prometheusMetrics.setRedisConnected(false);
    });

    redisClient.on('reconnecting', () => {
      logger.info('Redis reconnecting');
    });
  }

  return redisClient;
}

/**
 * Get the circuit breaker for Redis operations.
 * Creates the circuit breaker on first call.
 *
 * @param redis - Redis client instance
 * @returns Circuit breaker instance
 */
export function getRedisCircuitBreaker(redis: Redis): CircuitBreaker<unknown[], unknown> {
  if (!redisCircuitBreaker) {
    // Create a wrapper function for Redis operations
    const redisOperation = async <T>(
      operation: () => Promise<T>
    ): Promise<T> => {
      return operation();
    };

    redisCircuitBreaker = createCircuitBreaker(redisOperation, {
      name: 'redis',
      timeout: config.circuitBreaker.timeout,
      errorThresholdPercentage: config.circuitBreaker.errorThreshold,
      resetTimeout: config.circuitBreaker.resetTimeout,
      volumeThreshold: config.circuitBreaker.volumeThreshold,
    });

    // Configure fallback behavior based on degradation mode
    redisCircuitBreaker.fallback(() => {
      return handleFallback();
    });
  }

  return redisCircuitBreaker;
}

/**
 * Handle fallback when Redis is unavailable.
 * Implements graceful degradation based on configuration.
 *
 * @returns Fallback result based on degradation mode
 */
function handleFallback(): { allowed: boolean; fallback: true; remaining: number; resetTime: number } {
  fallbackCounter++;
  prometheusMetrics.recordFallback('redis_unavailable');

  // Throttled logging to prevent log flooding
  if (fallbackCounter % config.degradation.logWarningInterval === 1) {
    logger.warn(
      {
        mode: config.degradation.mode,
        fallbackCount: fallbackCounter,
      },
      'Redis unavailable, using fallback behavior'
    );
  }

  if (config.degradation.mode === 'deny') {
    return {
      allowed: false,
      fallback: true,
      remaining: 0,
      resetTime: Date.now() + 60000,
    };
  }

  // Fail-open: allow the request
  return {
    allowed: true,
    fallback: true,
    remaining: -1,
    resetTime: 0,
  };
}

/**
 * Execute a Redis operation with circuit breaker protection.
 * Automatically handles failures and falls back gracefully.
 *
 * @param operation - The Redis operation to execute
 * @param operationName - Name for logging and metrics
 * @returns Promise resolving to operation result or fallback
 */
export async function executeWithCircuitBreaker<T>(
  operation: () => Promise<T>,
  operationName: string = 'redis_operation'
): Promise<T | ReturnType<typeof handleFallback>> {
  const redis = getRedisClient();
  const breaker = getRedisCircuitBreaker(redis);
  const startTime = Date.now();

  try {
    const result = await breaker.fire(operation);
    const durationSeconds = (Date.now() - startTime) / 1000;
    prometheusMetrics.recordRedisOperation(operationName, true, durationSeconds);
    return result as T;
  } catch (error) {
    const durationSeconds = (Date.now() - startTime) / 1000;
    prometheusMetrics.recordRedisOperation(operationName, false, durationSeconds);

    logger.error(
      {
        operation: operationName,
        error: (error as Error).message,
        durationMs: Math.round(durationSeconds * 1000),
      },
      'Redis operation failed'
    );

    return handleFallback();
  }
}

/**
 * Get current Redis status for health checks.
 *
 * @returns Redis status object
 */
export async function getRedisStatus(): Promise<RedisStatus> {
  const redis = getRedisClient();
  const breaker = getRedisCircuitBreaker(redis);

  let circuitBreakerState: 'open' | 'closed' | 'half-open' = 'closed';
  if (breaker.opened) {
    circuitBreakerState = 'open';
  } else if (breaker.halfOpen) {
    circuitBreakerState = 'half-open';
  }

  try {
    const pingStart = Date.now();
    await redis.ping();
    const pingMs = Date.now() - pingStart;

    return {
      connected: true,
      circuitBreakerState,
      pingMs,
    };
  } catch (error) {
    return {
      connected: false,
      circuitBreakerState,
      lastError: (error as Error).message,
    };
  }
}

/**
 * Gracefully close the Redis client connection.
 * Should be called during application shutdown to clean up resources.
 *
 * @returns Promise that resolves when connection is closed
 */
export async function closeRedisClient(): Promise<void> {
  if (redisClient) {
    logger.info('Closing Redis connection');
    await redisClient.quit();
    redisClient = null;
    redisCircuitBreaker = null;
  }
}

/**
 * Record a rate limit check metric in Redis.
 * Metrics are aggregated per minute for efficient storage and querying.
 * Includes circuit breaker protection.
 *
 * @param redis - Redis client instance
 * @param type - Whether the request was 'allowed' or 'denied'
 * @param latencyMs - Time taken to perform the rate limit check in milliseconds
 * @param algorithm - The rate limiting algorithm used
 */
export async function recordMetric(
  redis: Redis,
  type: 'allowed' | 'denied',
  latencyMs: number,
  algorithm: string = 'unknown'
): Promise<void> {
  // Also record to Prometheus
  prometheusMetrics.recordCheck(algorithm, type === 'allowed', latencyMs / 1000);

  try {
    const now = Date.now();
    const minute = Math.floor(now / 60000);
    const key = `metrics:${minute}`;

    // Use pipeline for efficiency (batch multiple commands)
    const pipeline = redis.pipeline();
    pipeline.hincrby(key, 'total', 1);
    pipeline.hincrby(key, type, 1);
    pipeline.hincrbyfloat(key, 'latency_sum', latencyMs);

    // Store individual latencies for percentile calculation
    pipeline.lpush(`metrics:latencies:${minute}`, latencyMs);
    pipeline.ltrim(`metrics:latencies:${minute}`, 0, 999);

    // Apply configured TTLs
    pipeline.expire(key, config.ttl.metricsTtl);
    pipeline.expire(`metrics:latencies:${minute}`, config.ttl.latencyDetailsTtl);

    await pipeline.exec();
  } catch (error) {
    // Log but don't fail - metrics are non-critical
    logger.warn(
      { error: (error as Error).message },
      'Failed to record metric to Redis'
    );
  }
}

/**
 * Retrieve aggregated metrics for the last 5 minutes.
 * Calculates totals, averages, and percentiles from stored metric data.
 *
 * @param redis - Redis client instance
 * @returns Aggregated metrics including request counts, latencies, and active identifiers
 */
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

  // Initialize aggregation variables
  let totalRequests = 0;
  let allowedRequests = 0;
  let deniedRequests = 0;
  let latencySum = 0;
  const allLatencies: number[] = [];

  try {
    // Fetch metrics for the last 5 minutes in a single pipeline
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

    // Calculate p99 latency
    allLatencies.sort((a, b) => a - b);
    const p99Index = Math.floor(allLatencies.length * 0.99);
    const p99LatencyMs = allLatencies[p99Index] || 0;

    // Count active identifiers (approximate by counting rate limit keys)
    const keys = await redis.keys('ratelimit:*');
    const activeIdentifiers = keys.length;

    // Update Prometheus gauge
    prometheusMetrics.setActiveIdentifiers(activeIdentifiers);

    return {
      totalRequests,
      allowedRequests,
      deniedRequests,
      averageLatencyMs: totalRequests > 0 ? latencySum / totalRequests : 0,
      p99LatencyMs,
      activeIdentifiers,
    };
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to get metrics from Redis');

    // Return empty metrics on error
    return {
      totalRequests: 0,
      allowedRequests: 0,
      deniedRequests: 0,
      averageLatencyMs: 0,
      p99LatencyMs: 0,
      activeIdentifiers: 0,
    };
  }
}

/**
 * Calculate TTL for rate limit keys based on window size.
 *
 * @param windowSeconds - The rate limit window in seconds
 * @returns TTL in seconds
 */
export function calculateKeyTtl(windowSeconds: number): number {
  return Math.ceil(windowSeconds * config.ttl.windowMultiplier);
}

/**
 * Get TTL for bucket-based algorithm state (token/leaky bucket).
 *
 * @returns TTL in seconds
 */
export function getBucketStateTtl(): number {
  return config.ttl.bucketStateTtl;
}
