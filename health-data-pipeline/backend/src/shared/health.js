import { pool } from '../config/database.js';
import { redis } from '../config/redis.js';
import { logger } from './logger.js';

/**
 * Health check endpoints for Kubernetes probes and load balancers.
 *
 * WHY: Proper health checks enable:
 * - Liveness probe: Restart if service is deadlocked or corrupted
 * - Readiness probe: Only route traffic when dependencies are available
 * - Graceful deployment: New pods only receive traffic when ready
 * - Automatic recovery: Orchestrator can replace unhealthy instances
 *
 * We implement two distinct checks:
 * 1. /health - Basic liveness (is the process alive?)
 * 2. /ready - Readiness (are all dependencies healthy?)
 */

const startTime = Date.now();

/**
 * Liveness check - is the process responsive?
 * Should be fast and always succeed unless the process is truly dead.
 */
export async function livenessCheck() {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: process.env.npm_package_version || '1.0.0'
  };
}

/**
 * Readiness check - can the service handle requests?
 * Checks all critical dependencies.
 */
export async function readinessCheck() {
  const checks = {};
  let allHealthy = true;

  // Check database
  checks.database = await checkDatabase();
  if (!checks.database.healthy) allHealthy = false;

  // Check Redis/Valkey cache
  checks.cache = await checkCache();
  if (!checks.cache.healthy) allHealthy = false;

  return {
    status: allHealthy ? 'ready' : 'degraded',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    checks
  };
}

/**
 * Check database connectivity and query performance.
 */
async function checkDatabase() {
  const start = Date.now();
  try {
    // Run a simple query to verify connectivity
    const result = await pool.query('SELECT 1 as check');

    // Also check pool health
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount
    };

    const latencyMs = Date.now() - start;

    // Warn if latency is too high
    if (latencyMs > 100) {
      logger.warn({
        msg: 'Database health check slow',
        latencyMs,
        poolStats
      });
    }

    return {
      healthy: true,
      latencyMs,
      pool: poolStats
    };
  } catch (error) {
    logger.error({
      msg: 'Database health check failed',
      error: error.message
    });

    return {
      healthy: false,
      error: error.message,
      latencyMs: Date.now() - start
    };
  }
}

/**
 * Check Redis/Valkey connectivity.
 */
async function checkCache() {
  const start = Date.now();
  try {
    // PING to verify connection
    const pong = await redis.ping();

    if (pong !== 'PONG') {
      throw new Error(`Unexpected PING response: ${pong}`);
    }

    const latencyMs = Date.now() - start;

    // Get memory info for monitoring
    const info = await redis.info('memory');
    const usedMemory = info.match(/used_memory:(\d+)/)?.[1];

    return {
      healthy: true,
      latencyMs,
      usedMemoryBytes: usedMemory ? parseInt(usedMemory, 10) : null
    };
  } catch (error) {
    logger.error({
      msg: 'Cache health check failed',
      error: error.message
    });

    return {
      healthy: false,
      error: error.message,
      latencyMs: Date.now() - start
    };
  }
}

/**
 * Express router for health endpoints.
 */
export function healthRoutes(app) {
  // Liveness probe - is the process alive?
  app.get('/health', async (req, res) => {
    try {
      const health = await livenessCheck();
      res.json(health);
    } catch (error) {
      logger.error({ msg: 'Liveness check failed', error: error.message });
      res.status(500).json({ status: 'error', error: error.message });
    }
  });

  // Readiness probe - is the service ready to handle traffic?
  app.get('/ready', async (req, res) => {
    try {
      const ready = await readinessCheck();
      const statusCode = ready.status === 'ready' ? 200 : 503;
      res.status(statusCode).json(ready);
    } catch (error) {
      logger.error({ msg: 'Readiness check failed', error: error.message });
      res.status(503).json({ status: 'error', error: error.message });
    }
  });

  // Deep health check with more details (for debugging)
  app.get('/health/deep', async (req, res) => {
    try {
      const ready = await readinessCheck();
      const liveness = await livenessCheck();

      res.json({
        ...liveness,
        ...ready,
        memory: process.memoryUsage(),
        pid: process.pid
      });
    } catch (error) {
      logger.error({ msg: 'Deep health check failed', error: error.message });
      res.status(500).json({ status: 'error', error: error.message });
    }
  });
}

export default { livenessCheck, readinessCheck, healthRoutes };
