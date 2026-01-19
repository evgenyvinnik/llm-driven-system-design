/**
 * Health check service for Strava fitness tracking platform
 *
 * Provides:
 * - Liveness check (is the process running?)
 * - Readiness check (are dependencies available?)
 * - Detailed component health with latency measurements
 */
import { Router, Request, Response } from 'express';
import { pool } from '../utils/db.js';
import { getClient } from '../utils/redis.js';
import { healthCheck as healthConfig } from './config.js';
import { dbConnectionsActive, dbConnectionsIdle, redisConnectionStatus } from './metrics.js';
import { logger } from './logger.js';

const log = logger.child({ component: 'health' });

/**
 * Health status enum
 */
export const HealthStatus = {
  HEALTHY: 'healthy',
  DEGRADED: 'degraded',
  UNHEALTHY: 'unhealthy'
} as const;

export type HealthStatusType = typeof HealthStatus[keyof typeof HealthStatus];

export interface ComponentHealth {
  status: HealthStatusType;
  latencyMs: number;
  details?: Record<string, unknown>;
  error?: string;
}

export interface ReadinessResult {
  status: HealthStatusType;
  timestamp: string;
  components: {
    database: ComponentHealth;
    redis: ComponentHealth;
  };
}

export interface LivenessResult {
  status: HealthStatusType;
  timestamp: string;
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
}

export interface DetailedHealthResult extends ReadinessResult {
  process: {
    uptime: number;
    memoryUsage: {
      heapUsed: string;
      heapTotal: string;
      rss: string;
    };
    nodeVersion: string;
    pid: number;
  };
}

/**
 * Check PostgreSQL database health
 */
export async function checkDatabase(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await Promise.race([
      pool.query('SELECT 1 as health_check'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Database health check timeout')), healthConfig.timeoutMs)
      )
    ]);

    const latencyMs = Date.now() - start;

    // Update connection metrics
    dbConnectionsActive.set(pool.totalCount - pool.idleCount);
    dbConnectionsIdle.set(pool.idleCount);

    return {
      status: HealthStatus.HEALTHY,
      latencyMs,
      details: {
        totalConnections: pool.totalCount,
        activeConnections: pool.totalCount - pool.idleCount,
        idleConnections: pool.idleCount,
        waitingCount: pool.waitingCount
      }
    };
  } catch (error) {
    const err = error as Error;
    log.error({ error: err.message }, 'Database health check failed');
    return {
      status: HealthStatus.UNHEALTHY,
      latencyMs: Date.now() - start,
      error: err.message
    };
  }
}

/**
 * Check Redis health
 */
export async function checkRedis(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const client = getClient();

    const pong = await Promise.race([
      client.ping(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Redis health check timeout')), healthConfig.timeoutMs)
      )
    ]);

    const latencyMs = Date.now() - start;

    // Update connection status metric
    redisConnectionStatus.set(1);

    // Get Redis info
    const info = await client.info('memory');
    const usedMemory = info.match(/used_memory:(\d+)/)?.[1];

    return {
      status: HealthStatus.HEALTHY,
      latencyMs,
      details: {
        response: pong,
        usedMemoryBytes: usedMemory ? parseInt(usedMemory) : null
      }
    };
  } catch (error) {
    const err = error as Error;
    redisConnectionStatus.set(0);
    log.error({ error: err.message }, 'Redis health check failed');
    return {
      status: HealthStatus.UNHEALTHY,
      latencyMs: Date.now() - start,
      error: err.message
    };
  }
}

/**
 * Perform full readiness check
 */
export async function checkReadiness(): Promise<ReadinessResult> {
  const [dbHealth, redisHealth] = await Promise.all([
    checkDatabase(),
    checkRedis()
  ]);

  const components = {
    database: dbHealth,
    redis: redisHealth
  };

  // Determine overall status
  const statuses = Object.values(components).map(c => c.status);
  let overallStatus: HealthStatusType;

  if (statuses.every(s => s === HealthStatus.HEALTHY)) {
    overallStatus = HealthStatus.HEALTHY;
  } else if (statuses.some(s => s === HealthStatus.UNHEALTHY)) {
    overallStatus = HealthStatus.UNHEALTHY;
  } else {
    overallStatus = HealthStatus.DEGRADED;
  }

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    components
  };
}

/**
 * Simple liveness check (process is running)
 */
export function checkLiveness(): LivenessResult {
  return {
    status: HealthStatus.HEALTHY,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage()
  };
}

/**
 * Get detailed system health including all metrics
 */
export async function getDetailedHealth(): Promise<DetailedHealthResult> {
  const readiness = await checkReadiness();
  const liveness = checkLiveness();

  return {
    ...readiness,
    process: {
      uptime: liveness.uptime,
      memoryUsage: {
        heapUsed: Math.round(liveness.memoryUsage.heapUsed / 1024 / 1024) + 'MB',
        heapTotal: Math.round(liveness.memoryUsage.heapTotal / 1024 / 1024) + 'MB',
        rss: Math.round(liveness.memoryUsage.rss / 1024 / 1024) + 'MB'
      },
      nodeVersion: process.version,
      pid: process.pid
    }
  };
}

/**
 * Express routes for health checks
 */
export function createHealthRoutes(router: Router): Router {
  // Basic liveness probe (for Kubernetes liveness)
  router.get('/health', (_req: Request, res: Response) => {
    res.json(checkLiveness());
  });

  // Readiness probe (for Kubernetes readiness)
  router.get('/health/ready', async (_req: Request, res: Response) => {
    const health = await checkReadiness();

    if (health.status === HealthStatus.UNHEALTHY) {
      res.status(503).json(health);
    } else {
      res.json(health);
    }
  });

  // Detailed health (for debugging/ops)
  router.get('/health/detailed', async (_req: Request, res: Response) => {
    const health = await getDetailedHealth();
    res.json(health);
  });

  return router;
}

export default {
  checkDatabase,
  checkRedis,
  checkReadiness,
  checkLiveness,
  getDetailedHealth,
  createHealthRoutes,
  HealthStatus
};
