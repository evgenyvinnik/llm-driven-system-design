/**
 * Health Check Module
 *
 * Provides comprehensive health check endpoints for monitoring and orchestration.
 * Supports both shallow (liveness) and deep (readiness) checks.
 *
 * WHY Health Checks are Critical:
 * 1. Load balancers need liveness probes to route traffic
 * 2. Kubernetes/container orchestration needs readiness probes
 * 3. Monitoring systems need to detect degraded states
 * 4. On-call engineers need quick system status overview
 *
 * Health Check Types:
 * - Liveness (/health/live): Is the process running?
 * - Readiness (/health/ready): Can it serve traffic?
 * - Deep (/health/deep): Detailed component status
 *
 * @see architecture.md for system dependencies
 */
import { Router, Request, Response } from 'express';
import pool from '../db/index.js';
import redis from '../db/redis.js';
import { getAllCircuitBreakerStats } from './circuit-breaker.js';
import { logger } from './logger.js';

const router = Router();

/**
 * Component health status.
 */
interface ComponentHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTimeMs?: number;
  message?: string;
  lastChecked: string;
}

/**
 * Overall system health response.
 */
interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  version: string;
  uptime: number;
  timestamp: string;
  components?: ComponentHealth[];
  circuitBreakers?: Array<{
    name: string;
    state: string;
    successRate?: number;
  }>;
}

// Track server start time for uptime calculation
const startTime = Date.now();

/**
 * Checks PostgreSQL connectivity and query performance.
 */
async function checkDatabase(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    const responseTime = Date.now() - start;

    // Check connection pool stats
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    return {
      name: 'postgresql',
      status: responseTime > 1000 ? 'degraded' : 'healthy',
      responseTimeMs: responseTime,
      message:
        responseTime > 1000
          ? 'Slow response time'
          : `Pool: ${poolStats.idle}/${poolStats.total} idle`,
      lastChecked: new Date().toISOString(),
    };
  } catch (error) {
    return {
      name: 'postgresql',
      status: 'unhealthy',
      responseTimeMs: Date.now() - start,
      message: (error as Error).message,
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Checks Redis connectivity and memory usage.
 */
async function checkRedis(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const pong = await redis.ping();
    const responseTime = Date.now() - start;

    if (pong !== 'PONG') {
      return {
        name: 'redis',
        status: 'degraded',
        responseTimeMs: responseTime,
        message: `Unexpected response: ${pong}`,
        lastChecked: new Date().toISOString(),
      };
    }

    // Get memory info for observability
    const info = await redis.info('memory');
    const usedMemoryMatch = info.match(/used_memory_human:(\S+)/);
    const usedMemory = usedMemoryMatch ? usedMemoryMatch[1] : 'unknown';

    return {
      name: 'redis',
      status: responseTime > 100 ? 'degraded' : 'healthy',
      responseTimeMs: responseTime,
      message: responseTime > 100 ? 'Slow response time' : `Memory: ${usedMemory}`,
      lastChecked: new Date().toISOString(),
    };
  } catch (error) {
    return {
      name: 'redis',
      status: 'unhealthy',
      responseTimeMs: Date.now() - start,
      message: (error as Error).message,
      lastChecked: new Date().toISOString(),
    };
  }
}

/**
 * Checks circuit breaker states for payment networks.
 */
function checkCircuitBreakers(): Array<{ name: string; state: string; successRate?: number }> {
  const stats = getAllCircuitBreakerStats();
  return stats.map((cb) => ({
    name: cb.name,
    state: cb.state,
    successRate:
      cb.stats.fires > 0
        ? Math.round((cb.stats.successes / cb.stats.fires) * 100)
        : undefined,
  }));
}

/**
 * Determines overall system status from component statuses.
 */
function determineOverallStatus(components: ComponentHealth[]): 'healthy' | 'degraded' | 'unhealthy' {
  const hasUnhealthy = components.some((c) => c.status === 'unhealthy');
  const hasDegraded = components.some((c) => c.status === 'degraded');

  if (hasUnhealthy) return 'unhealthy';
  if (hasDegraded) return 'degraded';
  return 'healthy';
}

/**
 * GET /health/live
 * Liveness probe - is the process running?
 * Returns 200 if the process is alive, regardless of dependencies.
 * Used by: Container orchestration for process restarts.
 */
router.get('/live', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/ready
 * Readiness probe - can the service handle traffic?
 * Checks critical dependencies (database, cache).
 * Used by: Load balancers for traffic routing.
 */
router.get('/ready', async (_req: Request, res: Response) => {
  try {
    // Check critical dependencies in parallel
    const [dbHealth, redisHealth] = await Promise.all([checkDatabase(), checkRedis()]);

    const isReady = dbHealth.status !== 'unhealthy' && redisHealth.status !== 'unhealthy';

    const response: HealthResponse = {
      status: isReady ? 'healthy' : 'unhealthy',
      version: process.env.npm_package_version || '1.0.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      components: [dbHealth, redisHealth],
    };

    res.status(isReady ? 200 : 503).json(response);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Readiness check failed');
    res.status(503).json({
      status: 'unhealthy',
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /health/deep (or /health)
 * Deep health check - detailed status of all components.
 * Includes circuit breaker states and performance metrics.
 * Used by: Monitoring dashboards and on-call diagnosis.
 */
router.get(['/', '/deep'], async (_req: Request, res: Response) => {
  try {
    // Check all dependencies
    const [dbHealth, redisHealth] = await Promise.all([checkDatabase(), checkRedis()]);

    const components = [dbHealth, redisHealth];
    const circuitBreakers = checkCircuitBreakers();

    // Check if any circuit breaker is open
    const hasOpenBreaker = circuitBreakers.some((cb) => cb.state === 'open');
    if (hasOpenBreaker) {
      components.push({
        name: 'payment_networks',
        status: 'degraded',
        message: 'One or more payment network circuit breakers are open',
        lastChecked: new Date().toISOString(),
      });
    }

    const overallStatus = determineOverallStatus(components);

    const response: HealthResponse = {
      status: overallStatus,
      version: process.env.npm_package_version || '1.0.0',
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
      components,
      circuitBreakers,
    };

    // Return 503 only if critical components are unhealthy
    const httpStatus =
      dbHealth.status === 'unhealthy' || redisHealth.status === 'unhealthy' ? 503 : 200;

    res.status(httpStatus).json(response);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Deep health check failed');
    res.status(503).json({
      status: 'unhealthy',
      error: (error as Error).message,
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
