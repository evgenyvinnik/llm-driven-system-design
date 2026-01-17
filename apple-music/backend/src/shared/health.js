import { pool } from '../db/index.js';
import { redis } from '../services/redis.js';
import { logger } from './logger.js';

/**
 * Health check module for service observability.
 *
 * Provides:
 * - /health - Simple liveness check for load balancers
 * - /health/ready - Detailed readiness check with component status
 *
 * Benefits:
 * - Kubernetes/load balancer integration for traffic routing
 * - Component-level status for debugging
 * - Prevents traffic to unhealthy instances
 */

/**
 * Check PostgreSQL connectivity.
 */
async function checkPostgres() {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return {
      status: 'healthy',
      latencyMs: Date.now() - start
    };
  } catch (err) {
    logger.error({ err }, 'PostgreSQL health check failed');
    return {
      status: 'unhealthy',
      error: err.message,
      latencyMs: Date.now() - start
    };
  }
}

/**
 * Check Redis connectivity.
 */
async function checkRedis() {
  const start = Date.now();
  try {
    await redis.ping();
    return {
      status: 'healthy',
      latencyMs: Date.now() - start
    };
  } catch (err) {
    logger.error({ err }, 'Redis health check failed');
    return {
      status: 'unhealthy',
      error: err.message,
      latencyMs: Date.now() - start
    };
  }
}

/**
 * Simple liveness check.
 * Returns 200 if the service is running.
 * Used by load balancers for basic health verification.
 */
export async function livenessCheck(req, res) {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
}

/**
 * Detailed readiness check.
 * Checks all dependencies and returns component-level status.
 * Returns 503 if any critical component is unhealthy.
 */
export async function readinessCheck(req, res) {
  const startTime = Date.now();

  // Check all components in parallel
  const [postgres, redisStatus] = await Promise.all([
    checkPostgres(),
    checkRedis()
  ]);

  const components = {
    postgres,
    redis: redisStatus
  };

  // Determine overall status
  const isHealthy = Object.values(components).every(c => c.status === 'healthy');

  const response = {
    status: isHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.APP_VERSION || '1.0.0',
    components,
    totalLatencyMs: Date.now() - startTime
  };

  if (!isHealthy) {
    logger.warn({ components }, 'Readiness check failed');
  }

  res.status(isHealthy ? 200 : 503).json(response);
}

/**
 * Register health check routes on an Express app.
 */
export function registerHealthRoutes(app) {
  // Simple liveness probe
  app.get('/health', livenessCheck);

  // Detailed readiness probe
  app.get('/health/ready', readinessCheck);

  // Alias for compatibility
  app.get('/healthz', livenessCheck);
  app.get('/ready', readinessCheck);
}

export default {
  livenessCheck,
  readinessCheck,
  registerHealthRoutes
};
