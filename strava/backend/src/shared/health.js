/**
 * Health check service for Strava fitness tracking platform
 *
 * Provides:
 * - Liveness check (is the process running?)
 * - Readiness check (are dependencies available?)
 * - Detailed component health with latency measurements
 */
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
};

/**
 * Check PostgreSQL database health
 */
export async function checkDatabase() {
  const start = Date.now();
  try {
    const result = await Promise.race([
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
    log.error({ error: error.message }, 'Database health check failed');
    return {
      status: HealthStatus.UNHEALTHY,
      latencyMs: Date.now() - start,
      error: error.message
    };
  }
}

/**
 * Check Redis health
 */
export async function checkRedis() {
  const start = Date.now();
  try {
    const client = getClient();

    const pong = await Promise.race([
      client.ping(),
      new Promise((_, reject) =>
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
    redisConnectionStatus.set(0);
    log.error({ error: error.message }, 'Redis health check failed');
    return {
      status: HealthStatus.UNHEALTHY,
      latencyMs: Date.now() - start,
      error: error.message
    };
  }
}

/**
 * Perform full readiness check
 */
export async function checkReadiness() {
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
  let overallStatus;

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
export function checkLiveness() {
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
export async function getDetailedHealth() {
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
export function createHealthRoutes(router) {
  // Basic liveness probe (for Kubernetes liveness)
  router.get('/health', (req, res) => {
    res.json(checkLiveness());
  });

  // Readiness probe (for Kubernetes readiness)
  router.get('/health/ready', async (req, res) => {
    const health = await checkReadiness();

    if (health.status === HealthStatus.UNHEALTHY) {
      res.status(503).json(health);
    } else {
      res.json(health);
    }
  });

  // Detailed health (for debugging/ops)
  router.get('/health/detailed', async (req, res) => {
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
