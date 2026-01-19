/**
 * Health Check Endpoints
 *
 * Provides comprehensive health checking for:
 * - Liveness: Is the process running?
 * - Readiness: Is the service ready to accept traffic?
 * - Detailed health: Status of all dependencies
 *
 * Used by:
 * - Load balancers for routing decisions
 * - Kubernetes for pod lifecycle management
 * - Monitoring systems for alerting
 */
import { Request, Response } from 'express';
import { Pool } from 'pg';
import type { RedisClientType } from 'redis';
import { logger } from './logger.js';
import { getCircuitBreakerStats } from './circuitBreaker.js';

interface HealthCheckResult {
  status: string;
  latency_ms: number | null;
  error?: string;
}

interface MemoryCheck {
  status: string;
  heap_used_mb: number;
  heap_total_mb: number;
  rss_mb: number;
}

interface EventLoopCheck {
  status: string;
  lag_ms: number;
}

interface HealthChecks {
  postgres: HealthCheckResult;
  redis: HealthCheckResult;
  circuit_breakers: Record<string, unknown>;
  memory: MemoryCheck;
  event_loop: EventLoopCheck;
}

interface HealthCheckHandlers {
  liveness: (req: Request, res: Response) => void;
  readiness: (req: Request, res: Response) => Promise<void>;
  health: (req: Request, res: Response) => Promise<void>;
}

interface HealthCheckDeps {
  pool: Pool;
  redis: RedisClientType;
}

/**
 * Check PostgreSQL connectivity
 */
async function checkPostgres(pool: Pool): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return {
      status: 'healthy',
      latency_ms: Date.now() - start
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency_ms: null,
      error: (error as Error).message
    };
  }
}

/**
 * Check Redis connectivity
 */
async function checkRedis(redis: RedisClientType): Promise<HealthCheckResult> {
  const start = Date.now();
  try {
    await redis.ping();
    return {
      status: 'healthy',
      latency_ms: Date.now() - start
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency_ms: null,
      error: (error as Error).message
    };
  }
}

/**
 * Create health check endpoints
 */
function createHealthChecks(deps: HealthCheckDeps): HealthCheckHandlers {
  const { pool, redis } = deps;

  return {
    /**
     * Liveness probe - just checks if process is running
     * Returns 200 if process is alive
     */
    liveness: (_req: Request, res: Response): void => {
      res.json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor(process.uptime())
      });
    },

    /**
     * Readiness probe - checks if service can accept traffic
     * Returns 200 if ready, 503 if not
     */
    readiness: async (_req: Request, res: Response): Promise<void> => {
      try {
        // Check critical dependencies
        const [pgCheck, redisCheck] = await Promise.all([
          checkPostgres(pool),
          checkRedis(redis)
        ]);

        const isReady = pgCheck.status === 'healthy' && redisCheck.status === 'healthy';

        if (isReady) {
          res.json({
            status: 'ready',
            timestamp: new Date().toISOString()
          });
        } else {
          res.status(503).json({
            status: 'not ready',
            checks: {
              postgres: pgCheck,
              redis: redisCheck
            },
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        logger.error({ error: (error as Error).message }, 'readiness check failed');
        res.status(503).json({
          status: 'not ready',
          error: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    },

    /**
     * Detailed health check - comprehensive status of all components
     * Returns 200 if all healthy, 503 if any unhealthy
     */
    health: async (_req: Request, res: Response): Promise<void> => {
      try {
        const checks: HealthChecks = {} as HealthChecks;

        // Check PostgreSQL
        checks.postgres = await checkPostgres(pool);

        // Check Redis
        checks.redis = await checkRedis(redis);

        // Get circuit breaker status
        checks.circuit_breakers = getCircuitBreakerStats();

        // Memory usage
        const memUsage = process.memoryUsage();
        checks.memory = {
          status: 'healthy',
          heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
          heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
          rss_mb: Math.round(memUsage.rss / 1024 / 1024)
        };

        // Event loop lag (simple check)
        const startLag = Date.now();
        await new Promise(resolve => setImmediate(resolve));
        const eventLoopLag = Date.now() - startLag;
        checks.event_loop = {
          status: eventLoopLag < 100 ? 'healthy' : 'degraded',
          lag_ms: eventLoopLag
        };

        // Determine overall status
        const allHealthy =
          checks.postgres.status === 'healthy' &&
          checks.redis.status === 'healthy' &&
          checks.memory.status === 'healthy';

        const statusCode = allHealthy ? 200 : 503;
        const overallStatus = allHealthy ? 'healthy' : 'degraded';

        res.status(statusCode).json({
          status: overallStatus,
          version: process.env.npm_package_version || '1.0.0',
          instance: process.env.INSTANCE_ID || `port-${process.env.PORT || 3000}`,
          uptime_seconds: Math.floor(process.uptime()),
          checks,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error({ error: (error as Error).message }, 'health check failed');
        res.status(503).json({
          status: 'unhealthy',
          error: (error as Error).message,
          timestamp: new Date().toISOString()
        });
      }
    }
  };
}

/**
 * Simple health check for backward compatibility
 */
function simpleHealthCheck(_req: Request, res: Response): void {
  res.json({
    status: 'ok',
    port: process.env.PORT || 3000,
    timestamp: new Date().toISOString()
  });
}

export {
  createHealthChecks,
  checkPostgres,
  checkRedis,
  simpleHealthCheck
};
