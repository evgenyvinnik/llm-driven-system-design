/**
 * @fileoverview Health check endpoint for monitoring service status.
 * Provides detailed health information about all dependencies including
 * database, cache, and WebSocket connections.
 */

import { Router, Request, Response } from 'express';
import { pool, redis } from '../db/connection.js';
import { componentHealth, healthCheckLatency } from './metrics.js';
import { componentLoggers } from './logger.js';

const log = componentLoggers.db;
const router = Router();

/**
 * Health status for a component.
 */
interface ComponentHealth {
  status: 'up' | 'down';
  latency_ms?: number;
  error?: string;
}

/**
 * Full health response.
 */
interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime_seconds: number;
  components: {
    database: ComponentHealth;
    redis: ComponentHealth;
  };
}

/**
 * Checks PostgreSQL database health.
 *
 * @returns ComponentHealth for database
 */
async function checkDatabase(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    const latency = Date.now() - start;

    healthCheckLatency.labels('database').observe(latency / 1000);
    componentHealth.labels('database').set(1);

    return { status: 'up', latency_ms: latency };
  } catch (error) {
    const latency = Date.now() - start;
    healthCheckLatency.labels('database').observe(latency / 1000);
    componentHealth.labels('database').set(0);

    log.error({ error }, 'Database health check failed');
    return {
      status: 'down',
      latency_ms: latency,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Checks Redis cache health.
 *
 * @returns ComponentHealth for Redis
 */
async function checkRedis(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await redis.ping();
    const latency = Date.now() - start;

    healthCheckLatency.labels('redis').observe(latency / 1000);
    componentHealth.labels('redis').set(1);

    return { status: 'up', latency_ms: latency };
  } catch (error) {
    const latency = Date.now() - start;
    healthCheckLatency.labels('redis').observe(latency / 1000);
    componentHealth.labels('redis').set(0);

    log.error({ error }, 'Redis health check failed');
    return {
      status: 'down',
      latency_ms: latency,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * GET /health - Simple health check endpoint.
 * Returns 200 if the service is running.
 */
router.get('/', async (_req: Request, res: Response) => {
  const [dbHealth, redisHealth] = await Promise.all([checkDatabase(), checkRedis()]);

  const allHealthy = dbHealth.status === 'up' && redisHealth.status === 'up';
  const allUnhealthy = dbHealth.status === 'down' && redisHealth.status === 'down';

  let overallStatus: 'healthy' | 'degraded' | 'unhealthy';
  let httpStatus: number;

  if (allHealthy) {
    overallStatus = 'healthy';
    httpStatus = 200;
  } else if (allUnhealthy) {
    overallStatus = 'unhealthy';
    httpStatus = 503;
  } else {
    overallStatus = 'degraded';
    httpStatus = 200; // Still serving traffic in degraded mode
  }

  const response: HealthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime_seconds: Math.floor(process.uptime()),
    components: {
      database: dbHealth,
      redis: redisHealth,
    },
  };

  res.status(httpStatus).json(response);
});

/**
 * GET /health/live - Kubernetes liveness probe.
 * Returns 200 if the process is running.
 */
router.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'alive' });
});

/**
 * GET /health/ready - Kubernetes readiness probe.
 * Returns 200 if the service can accept traffic.
 */
router.get('/ready', async (_req: Request, res: Response) => {
  const [dbHealth, redisHealth] = await Promise.all([checkDatabase(), checkRedis()]);

  // Service is ready if at least database is available
  // (Redis failures can be tolerated with fallback to DB)
  if (dbHealth.status === 'up') {
    res.status(200).json({
      status: 'ready',
      database: dbHealth.status,
      redis: redisHealth.status,
    });
  } else {
    res.status(503).json({
      status: 'not_ready',
      database: dbHealth.status,
      redis: redisHealth.status,
    });
  }
});

export default router;
