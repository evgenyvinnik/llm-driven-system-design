/**
 * Health Check Service.
 *
 * Provides comprehensive health checking for all service dependencies.
 * Used by load balancers and orchestrators to determine instance health.
 *
 * Health Check Levels:
 * - Liveness: Is the process running? (basic /health endpoint)
 * - Readiness: Can the service handle requests? (all dependencies healthy)
 * - Detailed: Full status of each dependency with latency
 */
import { Request, Response, Router } from 'express';
import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';
import { s3Client } from '../services/storage.js';
import { getAllCircuitBreakerStats } from '../services/circuit-breaker.js';
import { logger } from '../services/logger.js';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { MINIO_CONFIG } from '../config.js';

/**
 * Health check result for a single dependency.
 */
interface DependencyHealth {
  status: 'healthy' | 'unhealthy' | 'degraded';
  latencyMs?: number;
  message?: string;
  lastChecked?: string;
}

/**
 * Full health check response.
 */
interface HealthResponse {
  status: 'healthy' | 'unhealthy' | 'degraded';
  version: string;
  uptime: number;
  timestamp: string;
  dependencies: Record<string, DependencyHealth>;
  circuitBreakers?: Record<string, unknown>;
}

/**
 * Cached health check results with TTL.
 */
let healthCache: {
  result: HealthResponse;
  expiry: number;
} | null = null;

const HEALTH_CACHE_TTL_MS = 5000; // 5 seconds

/**
 * Checks PostgreSQL database health.
 */
async function checkPostgres(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
      return {
        status: 'healthy',
        latencyMs: Date.now() - start,
        lastChecked: new Date().toISOString(),
      };
    } finally {
      client.release();
    }
  } catch (error) {
    logger.error({ error }, 'PostgreSQL health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Unknown error',
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Checks Redis connection health.
 */
async function checkRedis(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    await redis.ping();
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
      lastChecked: new Date().toISOString(),
    };
  } catch (error) {
    logger.error({ error }, 'Redis health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Unknown error',
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Checks MinIO/S3 storage health.
 */
async function checkStorage(): Promise<DependencyHealth> {
  const start = Date.now();
  try {
    await s3Client.send(
      new HeadBucketCommand({ Bucket: MINIO_CONFIG.bucket })
    );
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
      lastChecked: new Date().toISOString(),
    };
  } catch (error) {
    // Storage might be optional or not configured
    const latency = Date.now() - start;
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    // If it's a bucket not found or credentials issue, mark as degraded
    if (errorMessage.includes('NoSuchBucket') || errorMessage.includes('Access Denied')) {
      return {
        status: 'degraded',
        latencyMs: latency,
        message: 'Storage not fully configured',
        lastChecked: new Date().toISOString(),
      };
    }

    logger.error({ error }, 'Storage health check failed');
    return {
      status: 'unhealthy',
      latencyMs: latency,
      message: errorMessage,
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Performs full health check on all dependencies.
 *
 * @returns Complete health check response
 */
export async function performHealthCheck(): Promise<HealthResponse> {
  // Check cache
  if (healthCache && healthCache.expiry > Date.now()) {
    return healthCache.result;
  }

  // Run all health checks in parallel
  const [postgresHealth, redisHealth, storageHealth] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkStorage(),
  ]);

  const dependencies: Record<string, DependencyHealth> = {
    postgres: postgresHealth,
    redis: redisHealth,
    storage: storageHealth,
  };

  // Determine overall status
  const statuses = Object.values(dependencies).map((d) => d.status);
  let overallStatus: 'healthy' | 'unhealthy' | 'degraded' = 'healthy';

  if (statuses.includes('unhealthy')) {
    // Only mark unhealthy if critical dependencies fail
    if (postgresHealth.status === 'unhealthy' || redisHealth.status === 'unhealthy') {
      overallStatus = 'unhealthy';
    } else {
      overallStatus = 'degraded';
    }
  } else if (statuses.includes('degraded')) {
    overallStatus = 'degraded';
  }

  const result: HealthResponse = {
    status: overallStatus,
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    dependencies,
    circuitBreakers: getAllCircuitBreakerStats(),
  };

  // Cache result
  healthCache = {
    result,
    expiry: Date.now() + HEALTH_CACHE_TTL_MS,
  };

  return result;
}

/**
 * Creates health check router with multiple endpoints.
 *
 * Endpoints:
 * - GET /health - Basic liveness check
 * - GET /health/ready - Readiness check (all dependencies)
 * - GET /health/live - Simple liveness probe
 */
export function createHealthRouter(): Router {
  const router = Router();

  /**
   * GET /health
   * Basic health check - returns OK if service is running.
   * Used for simple liveness probes.
   */
  router.get('/', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /health/live
   * Simple liveness probe.
   * Returns 200 if process is running.
   */
  router.get('/live', (_req: Request, res: Response) => {
    res.status(200).send('OK');
  });

  /**
   * GET /health/ready
   * Readiness probe - checks all dependencies.
   * Returns 200 if service can handle requests, 503 otherwise.
   */
  router.get('/ready', async (_req: Request, res: Response) => {
    try {
      const health = await performHealthCheck();

      const statusCode = health.status === 'unhealthy' ? 503 : 200;
      res.status(statusCode).json(health);
    } catch (error) {
      logger.error({ error }, 'Health check failed');
      res.status(503).json({
        status: 'unhealthy',
        message: 'Health check failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * GET /health/details
   * Detailed health information including circuit breaker states.
   * Useful for debugging and monitoring dashboards.
   */
  router.get('/details', async (_req: Request, res: Response) => {
    try {
      const health = await performHealthCheck();

      // Add additional details
      const detailed = {
        ...health,
        process: {
          pid: process.pid,
          memory: process.memoryUsage(),
          nodeVersion: process.version,
          platform: process.platform,
        },
        database: {
          poolSize: pool.totalCount,
          idleConnections: pool.idleCount,
          waitingClients: pool.waitingCount,
        },
      };

      res.json(detailed);
    } catch (error) {
      logger.error({ error }, 'Detailed health check failed');
      res.status(500).json({
        status: 'error',
        message: 'Failed to get detailed health info',
      });
    }
  });

  return router;
}

/**
 * Express middleware for health check.
 * Adds X-Health-Status header to responses.
 */
export async function healthCheckMiddleware(
  _req: Request,
  res: Response,
  next: () => void
): Promise<void> {
  // Perform lightweight check
  try {
    await redis.ping();
    res.set('X-Health-Status', 'healthy');
  } catch {
    res.set('X-Health-Status', 'degraded');
  }
  next();
}

/**
 * Clears health check cache.
 * Useful for testing.
 */
export function clearHealthCache(): void {
  healthCache = null;
}

export default createHealthRouter;
