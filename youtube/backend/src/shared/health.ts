import { Request, Response } from 'express';
import { query } from '../utils/db.js';
import redis from '../utils/redis.js';
import { objectExists } from '../utils/storage.js';
import { getCircuitBreakerHealth, hasOpenCircuit } from './circuitBreaker.js';
import { transcodeQueueDepth } from './metrics.js';
import logger from './logger.js';
import config from '../config/index.js';

// ============ Type Definitions ============

interface HealthCheckResult {
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  error?: string;
}

interface MemoryUsage {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
}

interface HealthResponse {
  status: 'ok' | 'healthy' | 'degraded' | 'error';
  timestamp: string;
  uptime?: number;
  version?: string;
  checks?: Record<string, HealthCheckResult>;
  circuitBreakers?: Record<string, unknown>;
  memory?: MemoryUsage;
  error?: string;
}

/**
 * Health Check Module
 *
 * Provides two types of health checks:
 * 1. Liveness: Quick check to see if the service is running
 * 2. Readiness: Deep check of all dependencies
 */

// ============ Health Check Functions ============

/**
 * Check database health
 */
async function checkDatabase(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    await query('SELECT 1');
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Database health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: (error as Error).message,
    };
  }
}

/**
 * Check Redis health
 */
async function checkRedis(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    await redis.ping();
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Redis health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: (error as Error).message,
    };
  }
}

/**
 * Check MinIO health
 */
async function checkStorage(): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    // Try to check if a test key exists (doesn't need to exist)
    await objectExists(config.minio.buckets.processed, '.health-check');
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    const err = error as { name?: string; Code?: string; message?: string };
    // NotFound is OK - it means storage is reachable
    if (err.name === 'NotFound' || err.Code === 'NotFound') {
      return {
        status: 'healthy',
        latencyMs: Date.now() - start,
      };
    }
    logger.error({ error: err.message }, 'Storage health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: err.message,
    };
  }
}

/**
 * Get memory usage
 */
function getMemoryUsage(): MemoryUsage {
  const usage = process.memoryUsage();
  return {
    heapUsed: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotal: Math.round(usage.heapTotal / 1024 / 1024),
    external: Math.round(usage.external / 1024 / 1024),
    rss: Math.round(usage.rss / 1024 / 1024),
  };
}

// ============ Handler Functions ============

/**
 * Liveness check handler
 * Quick check - just confirms the service is running
 */
export const livenessHandler = (_req: Request, res: Response): void => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
  });
};

/**
 * Readiness check handler
 * Deep check - verifies all dependencies are healthy
 */
export const readinessHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    // Run all health checks in parallel
    const [database, redisHealth, storage] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkStorage(),
    ]);

    // Get circuit breaker status
    const circuitBreakers = getCircuitBreakerHealth();

    // Determine overall status
    const checks = { database, redis: redisHealth, storage };
    const allHealthy = Object.values(checks).every((c) => c.status === 'healthy');
    const hasCircuitIssues = hasOpenCircuit();

    const status = allHealthy && !hasCircuitIssues ? 'healthy' : 'degraded';

    const response: HealthResponse = {
      status,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      version: process.env.APP_VERSION || '1.0.0',
      checks,
      circuitBreakers,
      memory: getMemoryUsage(),
    };

    // Return 503 if critical services are down
    const httpStatus = database.status === 'unhealthy' ? 503 : 200;

    res.status(httpStatus).json(response);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Health check error');
    res.status(503).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: (error as Error).message,
    });
  }
};

/**
 * Detailed health handler for monitoring dashboards
 */
export const detailedHealthHandler = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [database, redisHealth, storage] = await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkStorage(),
    ]);

    const circuitBreakers = getCircuitBreakerHealth();

    // Get current queue depth from transcoding service
    let queueDepth = 0;
    try {
      // Import dynamically to avoid circular dependency
      const { getQueueLength } = await import('../services/transcoding.js');
      queueDepth = getQueueLength();
      transcodeQueueDepth.set(queueDepth);
    } catch {
      // Ignore if transcoding service not available
    }

    const checks = { database, redis: redisHealth, storage };
    const allHealthy = Object.values(checks).every((c) => c.status === 'healthy');

    res.json({
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      service: 'youtube-api',
      version: process.env.APP_VERSION || '1.0.0',
      node: process.version,
      environment: process.env.NODE_ENV || 'development',
      uptime: {
        seconds: Math.round(process.uptime()),
        formatted: formatUptime(process.uptime()),
      },
      checks,
      circuitBreakers,
      queues: {
        transcoding: {
          depth: queueDepth,
          status: queueDepth > 50 ? 'overloaded' : queueDepth > 10 ? 'busy' : 'normal',
        },
      },
      memory: getMemoryUsage(),
      cpu: {
        usage: process.cpuUsage(),
      },
    });
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Detailed health check error');
    res.status(503).json({
      status: 'error',
      error: (error as Error).message,
    });
  }
};

/**
 * Format uptime to human readable
 */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${secs}s`);

  return parts.join(' ');
}

export default {
  livenessHandler,
  readinessHandler,
  detailedHealthHandler,
};
