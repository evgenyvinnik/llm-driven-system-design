import { Request, Response } from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import { createComponentLogger } from './logger.js';

/**
 * Health check endpoint for container orchestration and load balancers.
 *
 * WHY COMPREHENSIVE HEALTH CHECKS:
 * - Kubernetes readiness probes: Determine if pod should receive traffic
 * - Kubernetes liveness probes: Determine if pod should be restarted
 * - Load balancer health: Remove unhealthy instances from rotation
 * - Monitoring: Alert on dependency failures before users notice
 *
 * HEALTH CHECK TYPES:
 * - /health (shallow): Just confirms the process is running (for liveness)
 * - /health/ready (deep): Checks all dependencies (for readiness)
 * - /health/live (shallow): Alias for liveness probe
 *
 * DEPENDENCY CHECKS:
 * - PostgreSQL: Can we execute a simple query?
 * - Redis: Can we ping the server?
 *
 * RESPONSE FORMAT:
 * - status: "healthy" | "degraded" | "unhealthy"
 * - checks: Individual check results with latency
 * - timestamp: When the check was performed
 */

const log = createComponentLogger('health');

/**
 * Result of a single health check.
 */
interface CheckResult {
  status: 'pass' | 'fail';
  latencyMs: number;
  message?: string;
}

/**
 * Full health check response.
 */
interface HealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  version: string;
  uptime: number;
  checks: {
    postgresql?: CheckResult;
    redis?: CheckResult;
  };
}

// Track server start time for uptime calculation
const startTime = Date.now();

/**
 * Check PostgreSQL connectivity.
 * Executes a simple query to verify the connection pool is working.
 */
async function checkPostgres(): Promise<CheckResult> {
  const start = performance.now();
  try {
    await pool.query('SELECT 1 AS health');
    return {
      status: 'pass',
      latencyMs: Math.round(performance.now() - start),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error }, 'PostgreSQL health check failed');
    return {
      status: 'fail',
      latencyMs: Math.round(performance.now() - start),
      message,
    };
  }
}

/**
 * Check Redis connectivity.
 * Sends a PING command to verify the connection.
 */
async function checkRedis(): Promise<CheckResult> {
  const start = performance.now();
  try {
    const response = await redis.ping();
    if (response === 'PONG') {
      return {
        status: 'pass',
        latencyMs: Math.round(performance.now() - start),
      };
    }
    return {
      status: 'fail',
      latencyMs: Math.round(performance.now() - start),
      message: `Unexpected response: ${response}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    log.error({ error }, 'Redis health check failed');
    return {
      status: 'fail',
      latencyMs: Math.round(performance.now() - start),
      message,
    };
  }
}

/**
 * Shallow health check handler (liveness probe).
 *
 * Returns 200 if the process is running.
 * Does NOT check dependencies - use for Kubernetes liveness probes.
 *
 * @example
 * app.get('/health', shallowHealthCheck);
 * app.get('/health/live', shallowHealthCheck);
 */
export function shallowHealthCheck(req: Request, res: Response): void {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
  });
}

/**
 * Deep health check handler (readiness probe).
 *
 * Checks all critical dependencies:
 * - PostgreSQL database connection
 * - Redis cache connection
 *
 * Returns:
 * - 200: All checks pass (healthy)
 * - 200: Some checks fail (degraded) - still serving traffic
 * - 503: All checks fail (unhealthy) - should not receive traffic
 *
 * @example
 * app.get('/health/ready', deepHealthCheck);
 */
export async function deepHealthCheck(req: Request, res: Response): Promise<void> {
  const [postgresResult, redisResult] = await Promise.all([
    checkPostgres(),
    checkRedis(),
  ]);

  const checks = {
    postgresql: postgresResult,
    redis: redisResult,
  };

  // Determine overall status
  const failedChecks = Object.values(checks).filter((c) => c.status === 'fail');
  let status: HealthResponse['status'];
  let httpStatus: number;

  if (failedChecks.length === 0) {
    status = 'healthy';
    httpStatus = 200;
  } else if (failedChecks.length < Object.keys(checks).length) {
    // Some checks failed but not all - degraded but still serving
    status = 'degraded';
    httpStatus = 200;
    log.warn({ failedChecks: failedChecks.length }, 'System in degraded state');
  } else {
    // All checks failed - unhealthy
    status = 'unhealthy';
    httpStatus = 503;
    log.error('All health checks failed, system unhealthy');
  }

  const response: HealthResponse = {
    status,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    checks,
  };

  res.status(httpStatus).json(response);
}

/**
 * Startup health check for initial readiness.
 *
 * Waits for dependencies to become available before the server
 * starts accepting traffic. Used for startup probes.
 *
 * @param timeoutMs - Maximum time to wait for dependencies
 * @returns Promise that resolves when dependencies are ready
 */
export async function waitForDependencies(timeoutMs: number = 30000): Promise<void> {
  const start = Date.now();
  const checkInterval = 1000; // Check every second

  while (Date.now() - start < timeoutMs) {
    try {
      const [postgresResult, redisResult] = await Promise.all([
        checkPostgres(),
        checkRedis(),
      ]);

      if (postgresResult.status === 'pass' && redisResult.status === 'pass') {
        log.info(
          {
            postgresLatency: postgresResult.latencyMs,
            redisLatency: redisResult.latencyMs,
          },
          'All dependencies ready'
        );
        return;
      }

      log.debug(
        { postgres: postgresResult.status, redis: redisResult.status },
        'Waiting for dependencies...'
      );
    } catch (error) {
      log.debug({ error }, 'Dependency check failed, retrying...');
    }

    await new Promise((resolve) => setTimeout(resolve, checkInterval));
  }

  throw new Error(`Dependencies not ready after ${timeoutMs}ms`);
}

export { checkPostgres, checkRedis };
