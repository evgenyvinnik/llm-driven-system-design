/**
 * @fileoverview Comprehensive health check endpoint.
 *
 * Provides detailed health status for all system dependencies:
 * - Database connectivity and latency
 * - Redis cache connectivity and latency
 * - Application uptime and version info
 *
 * Returns structured JSON with individual component health statuses.
 * Useful for load balancer health checks and monitoring dashboards.
 */

import { Router, Request, Response } from 'express';
import pool from '../db/pool.js';
import redis from '../db/redis.js';
import logger from './logger.js';

/**
 * Health status for an individual component.
 */
interface ComponentHealth {
  status: 'up' | 'down' | 'degraded';
  latency_ms?: number;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Overall health response structure.
 */
interface HealthResponse {
  status: 'healthy' | 'unhealthy' | 'degraded';
  version: string;
  uptime_seconds: number;
  timestamp: string;
  checks: {
    database: ComponentHealth;
    redis: ComponentHealth;
  };
}

/**
 * Application start time for uptime calculation.
 */
const startTime = Date.now();

/**
 * Checks database health by executing a simple query.
 *
 * @returns Promise resolving to component health status
 */
async function checkDatabase(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const result = await pool.query('SELECT 1 as ping');
    const latency = Date.now() - start;

    // Get pool statistics
    const poolStats = {
      totalCount: pool.totalCount,
      idleCount: pool.idleCount,
      waitingCount: pool.waitingCount,
    };

    return {
      status: 'up',
      latency_ms: latency,
      details: poolStats,
    };
  } catch (error) {
    const latency = Date.now() - start;
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, latency_ms: latency }, 'Database health check failed');

    return {
      status: 'down',
      latency_ms: latency,
      message,
    };
  }
}

/**
 * Checks Redis health by executing a PING command.
 *
 * @returns Promise resolving to component health status
 */
async function checkRedis(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const result = await redis.ping();
    const latency = Date.now() - start;

    if (result !== 'PONG') {
      return {
        status: 'degraded',
        latency_ms: latency,
        message: `Unexpected PING response: ${result}`,
      };
    }

    // Get Redis info for additional details
    const info = await redis.info('memory');
    const usedMemory = info.match(/used_memory:(\d+)/)?.[1];

    return {
      status: 'up',
      latency_ms: latency,
      details: usedMemory ? { used_memory_bytes: parseInt(usedMemory) } : undefined,
    };
  } catch (error) {
    const latency = Date.now() - start;
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ error, latency_ms: latency }, 'Redis health check failed');

    return {
      status: 'down',
      latency_ms: latency,
      message,
    };
  }
}

/**
 * Determines overall health status based on individual component statuses.
 *
 * @param checks - Map of component health statuses
 * @returns Overall health status
 */
function determineOverallStatus(
  checks: Record<string, ComponentHealth>
): 'healthy' | 'unhealthy' | 'degraded' {
  const statuses = Object.values(checks).map((c) => c.status);

  if (statuses.every((s) => s === 'up')) {
    return 'healthy';
  }

  // Database is critical - if it's down, system is unhealthy
  if (checks.database.status === 'down') {
    return 'unhealthy';
  }

  // Redis degraded/down = system degraded (can still function without cache)
  if (statuses.some((s) => s === 'down' || s === 'degraded')) {
    return 'degraded';
  }

  return 'healthy';
}

/**
 * Express router that exposes health check endpoints.
 *
 * Endpoints:
 * - GET /health - Full health check with all dependencies
 * - GET /health/live - Simple liveness probe (always returns 200 if process is running)
 * - GET /health/ready - Readiness probe (checks if system can serve traffic)
 */
export const healthRouter = Router();

/**
 * GET /health
 *
 * Comprehensive health check that verifies all system dependencies.
 * Returns 200 for healthy/degraded, 503 for unhealthy.
 */
healthRouter.get('/health', async (req: Request, res: Response) => {
  const [database, redisHealth] = await Promise.all([checkDatabase(), checkRedis()]);

  const checks = { database, redis: redisHealth };
  const status = determineOverallStatus(checks);

  const response: HealthResponse = {
    status,
    version: process.env.npm_package_version || '1.0.0',
    uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
    timestamp: new Date().toISOString(),
    checks,
  };

  const httpStatus = status === 'unhealthy' ? 503 : 200;
  res.status(httpStatus).json(response);
});

/**
 * GET /health/live
 *
 * Kubernetes liveness probe endpoint.
 * Returns 200 if the process is running. Used to detect hung processes.
 */
healthRouter.get('/health/live', (req: Request, res: Response) => {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/ready
 *
 * Kubernetes readiness probe endpoint.
 * Returns 200 only if the service can handle traffic (database connected).
 * Used to control traffic routing during deployments.
 */
healthRouter.get('/health/ready', async (req: Request, res: Response) => {
  const database = await checkDatabase();

  if (database.status === 'up') {
    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
    });
  } else {
    res.status(503).json({
      status: 'not_ready',
      reason: database.message || 'Database unavailable',
      timestamp: new Date().toISOString(),
    });
  }
});

export default healthRouter;
