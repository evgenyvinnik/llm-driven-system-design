/**
 * Health check endpoints for monitoring and orchestration.
 * Provides liveness, readiness, and deep health checks.
 *
 * Endpoints:
 * - GET /health/live - Basic liveness check (is process running?)
 * - GET /health/ready - Readiness check (can accept traffic?)
 * - GET /health/deep - Deep check with component status and latencies
 *
 * @module routes/health
 */

import { Router, Request, Response } from 'express';
import { pool } from '../utils/database.js';
import { redis } from '../utils/redis.js';
import { s3Client, BUCKET_NAME } from '../utils/storage.js';
import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { logger } from '../shared/logger.js';

const router = Router();

/**
 * Component health status
 */
interface ComponentHealth {
  status: 'up' | 'down' | 'degraded';
  latencyMs: number;
  error?: string;
}

/**
 * Deep health check response
 */
interface DeepHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  components: {
    postgresql: ComponentHealth;
    redis: ComponentHealth;
    minio: ComponentHealth;
  };
  metrics?: {
    activeConnections: number;
    cacheHitRate?: number;
  };
}

/**
 * Check PostgreSQL connection health
 */
async function checkPostgres(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const result = await pool.query('SELECT 1');
    return {
      status: 'up',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: (error as Error).message,
    };
  }
}

/**
 * Check Redis connection health
 */
async function checkRedis(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const result = await redis.ping();
    if (result === 'PONG') {
      return {
        status: 'up',
        latencyMs: Date.now() - start,
      };
    }
    return {
      status: 'degraded',
      latencyMs: Date.now() - start,
      error: 'Unexpected ping response',
    };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: (error as Error).message,
    };
  }
}

/**
 * Check MinIO/S3 connection health
 */
async function checkMinio(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await s3Client.send(new HeadBucketCommand({ Bucket: BUCKET_NAME }));
    return {
      status: 'up',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'down',
      latencyMs: Date.now() - start,
      error: (error as Error).message,
    };
  }
}

/**
 * GET /health/live - Basic liveness probe.
 * Returns 200 if the process is running.
 * Used by orchestrators to check if the container needs restart.
 */
router.get('/live', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/ready - Readiness probe.
 * Returns 200 if the service can accept traffic.
 * Checks that critical dependencies (DB, Redis) are reachable.
 */
router.get('/ready', async (req: Request, res: Response) => {
  try {
    const [postgres, redisHealth] = await Promise.all([
      checkPostgres(),
      checkRedis(),
    ]);

    const isReady = postgres.status === 'up' && redisHealth.status === 'up';

    if (isReady) {
      res.status(200).json({
        status: 'ready',
        timestamp: new Date().toISOString(),
      });
    } else {
      logger.warn(
        { postgres: postgres.status, redis: redisHealth.status },
        'Service not ready'
      );
      res.status(503).json({
        status: 'not ready',
        timestamp: new Date().toISOString(),
        postgres: postgres.status,
        redis: redisHealth.status,
      });
    }
  } catch (error) {
    logger.error({ error }, 'Readiness check failed');
    res.status(503).json({
      status: 'not ready',
      error: 'Health check failed',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /health/deep - Deep health check with component details.
 * Returns detailed status of all components with latencies.
 * Used by monitoring systems for detailed observability.
 */
router.get('/deep', async (req: Request, res: Response) => {
  try {
    const [postgres, redisHealth, minio] = await Promise.all([
      checkPostgres(),
      checkRedis(),
      checkMinio(),
    ]);

    // Determine overall status
    const components = { postgresql: postgres, redis: redisHealth, minio };
    const componentStatuses = Object.values(components).map((c) => c.status);

    let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
    if (componentStatuses.every((s) => s === 'up')) {
      overallStatus = 'healthy';
    } else if (componentStatuses.some((s) => s === 'down')) {
      overallStatus = 'unhealthy';
    } else {
      overallStatus = 'degraded';
    }

    // Get additional metrics
    let activeConnections = 0;
    try {
      const poolStats = await pool.query(
        `SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()`
      );
      activeConnections = parseInt(poolStats.rows[0].count, 10);
    } catch {
      // Ignore - not critical
    }

    const response: DeepHealthResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version || '1.0.0',
      components,
      metrics: {
        activeConnections,
      },
    };

    const statusCode = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 200 : 503;

    res.status(statusCode).json(response);
  } catch (error) {
    logger.error({ error }, 'Deep health check failed');
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
});

/**
 * GET /health - Simple health check (backwards compatibility).
 * Alias for /health/live.
 */
router.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

export default router;
