/**
 * Health check and metrics routes for the job scheduler API.
 * Includes liveness/readiness probes for Kubernetes and system metrics.
 * @module api/schedule-routes
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from './types';
import { authenticate } from '../shared/auth';
import { metricsHandler, updateQueueMetrics } from '../shared/metrics';
import { getCircuitBreakerStates } from '../shared/circuit-breaker';
import { healthCheck as dbHealthCheck } from '../db/pool';
import { healthCheck as redisHealthCheck, redis } from '../queue/redis';
import { queue } from '../queue/reliable-queue';
import * as db from '../db/repository';
import { ApiResponse } from '../types/index';
import { HealthCheckData, WorkerData } from './types';

const router = Router();

/**
 * GET /metrics - Prometheus metrics endpoint.
 *
 * @description Exposes application metrics in Prometheus format for monitoring.
 * Includes job counts, execution statistics, queue depths, and worker status.
 * This endpoint is public and does not require authentication.
 *
 * @route GET /metrics
 * @access Public
 *
 * @returns {string} Prometheus-formatted metrics text
 */
router.get('/metrics', metricsHandler);

/**
 * GET /api/v1/health - System health check endpoint.
 *
 * @description Checks connectivity to PostgreSQL and Redis, returning overall
 * system health status. Returns 503 if any dependency is unhealthy.
 * This endpoint is public and does not require authentication.
 *
 * @route GET /api/v1/health
 * @access Public
 *
 * @returns {ApiResponse<HealthCheckData>} 200 - All dependencies healthy
 * @returns {ApiResponse<HealthCheckData>} 503 - One or more dependencies unhealthy
 *
 * @example
 * ```bash
 * curl -X GET /api/v1/health
 * # Response: {"success":true,"data":{"db":true,"redis":true,"uptime":3600,"version":"1.0.0"}}
 * ```
 */
router.get(
  '/api/v1/health',
  asyncHandler(async (_req, res) => {
    const [dbOk, redisOk] = await Promise.all([dbHealthCheck(), redisHealthCheck()]);

    const healthy = dbOk && redisOk;
    const response: ApiResponse<HealthCheckData> = {
      success: healthy,
      data: {
        db: dbOk,
        redis: redisOk,
        uptime: process.uptime(),
        version: process.env.npm_package_version || '1.0.0',
      },
    };

    res.status(healthy ? 200 : 503).json(response);
  })
);

/**
 * GET /api/v1/health/ready - Kubernetes readiness probe endpoint.
 *
 * @description Indicates whether the application is ready to receive traffic.
 * Checks database and Redis connectivity. Used by Kubernetes to determine
 * if the pod should receive traffic from the load balancer.
 *
 * @route GET /api/v1/health/ready
 * @access Public
 *
 * @returns {Object} 200 - Application is ready to receive traffic
 * @returns {Object} 503 - Application is not ready (dependencies unavailable)
 *
 * @example
 * ```bash
 * curl -X GET /api/v1/health/ready
 * # Response: {"ready":true,"db":true,"redis":true}
 * ```
 */
router.get(
  '/api/v1/health/ready',
  asyncHandler(async (_req, res) => {
    const [dbOk, redisOk] = await Promise.all([dbHealthCheck(), redisHealthCheck()]);
    const ready = dbOk && redisOk;
    res.status(ready ? 200 : 503).json({ ready, db: dbOk, redis: redisOk });
  })
);

/**
 * GET /api/v1/health/live - Kubernetes liveness probe endpoint.
 *
 * @description Indicates whether the application is alive and should not be restarted.
 * This is a simple check that always returns true if the process is running.
 * Used by Kubernetes to determine if the pod should be restarted.
 *
 * @route GET /api/v1/health/live
 * @access Public
 *
 * @returns {Object} 200 - Application is alive
 *
 * @example
 * ```bash
 * curl -X GET /api/v1/health/live
 * # Response: {"alive":true}
 * ```
 */
router.get('/api/v1/health/live', (_req: Request, res: Response) => {
  res.status(200).json({ alive: true });
});

/**
 * GET /api/v1/metrics/system - Get aggregated system metrics.
 *
 * @description Returns comprehensive system metrics including job statistics,
 * queue depths, worker status, and circuit breaker states. Used by the dashboard
 * to display real-time system health. Requires authentication.
 *
 * @route GET /api/v1/metrics/system
 * @access Authenticated users
 *
 * @returns {ApiResponse<SystemMetricsData>} 200 - Aggregated system metrics
 *
 * @example
 * ```bash
 * curl -X GET /api/v1/metrics/system
 * # Response includes jobs, queue, workers, and circuit breaker data
 * ```
 */
router.get(
  '/api/v1/metrics/system',
  authenticate,
  asyncHandler(async (_req, res) => {
    const [dbMetrics, queueStats] = await Promise.all([
      db.getSystemMetrics(),
      queue.getStats(),
    ]);

    // Update queue metrics for Prometheus
    await updateQueueMetrics(queueStats);

    // Get worker count from Redis
    const workers = await redis.hgetall('job_scheduler:workers');
    const activeWorkers = Object.values(workers).filter((w) => {
      const worker: WorkerData = JSON.parse(w);
      const lastHeartbeat = new Date(worker.last_heartbeat);
      const isRecent = Date.now() - lastHeartbeat.getTime() < 60000; // 1 minute
      return isRecent;
    }).length;

    // Get circuit breaker states
    const circuitBreakers = Object.fromEntries(getCircuitBreakerStates());

    res.json({
      success: true,
      data: {
        jobs: dbMetrics,
        queue: queueStats,
        workers: {
          active: activeWorkers,
          total: Object.keys(workers).length,
        },
        circuitBreakers,
      },
    });
  })
);

/**
 * GET /api/v1/metrics/executions - Get hourly execution statistics.
 *
 * @description Returns aggregated execution statistics grouped by hour for the
 * specified time period. Useful for charting execution trends and identifying
 * patterns. Requires authentication.
 *
 * @route GET /api/v1/metrics/executions
 * @access Authenticated users
 *
 * @param {string} [req.query.hours=24] - Number of hours of history to retrieve
 *
 * @returns {ApiResponse<ExecutionStats[]>} 200 - Hourly execution statistics
 *
 * @example
 * ```bash
 * curl -X GET '/api/v1/metrics/executions?hours=48'
 * # Response: {"success":true,"data":[{"hour":"2024-01-15T10:00:00Z","completed":50,"failed":2},...]}
 * ```
 */
router.get(
  '/api/v1/metrics/executions',
  authenticate,
  asyncHandler(async (req, res) => {
    const hours = parseInt(req.query.hours as string) || 24;
    const stats = await db.getExecutionStats(hours);

    res.json({
      success: true,
      data: stats,
    } as ApiResponse<typeof stats>);
  })
);

/**
 * GET /api/v1/workers - Get list of registered workers.
 *
 * @description Returns a list of all workers that have registered with the system,
 * including their current status, last heartbeat time, and job completion statistics.
 * Requires authentication.
 *
 * @route GET /api/v1/workers
 * @access Authenticated users
 *
 * @returns {ApiResponse<WorkerData[]>} 200 - List of registered workers
 *
 * @example
 * ```bash
 * curl -X GET /api/v1/workers
 * # Response: {"success":true,"data":[{"id":"worker-1","status":"idle","jobs_completed":150},...]}
 * ```
 */
router.get(
  '/api/v1/workers',
  authenticate,
  asyncHandler(async (_req, res) => {
    const workers = await redis.hgetall('job_scheduler:workers');

    const workerList = Object.values(workers).map((w) => JSON.parse(w));

    res.json({
      success: true,
      data: workerList,
    } as ApiResponse<typeof workerList>);
  })
);

/**
 * GET /api/v1/dead-letter - Get items from the dead letter queue.
 *
 * @description Retrieves failed executions that have exhausted all retry attempts
 * and been moved to the dead letter queue. These items require manual intervention.
 * Requires authentication.
 *
 * @route GET /api/v1/dead-letter
 * @access Authenticated users
 *
 * @param {string} [req.query.start=0] - Starting index for pagination
 * @param {string} [req.query.count=100] - Number of items to retrieve
 *
 * @returns {ApiResponse<DeadLetterItem[]>} 200 - List of dead letter queue items
 *
 * @example
 * ```bash
 * curl -X GET '/api/v1/dead-letter?start=0&count=50'
 * # Response: {"success":true,"data":[{"execution_id":"...","job_id":"...","error":"..."},...]}
 * ```
 */
router.get(
  '/api/v1/dead-letter',
  authenticate,
  asyncHandler(async (req, res) => {
    const start = parseInt(req.query.start as string) || 0;
    const count = parseInt(req.query.count as string) || 100;

    const items = await queue.getDeadLetterItems(start, start + count - 1);

    res.json({
      success: true,
      data: items,
    } as ApiResponse<typeof items>);
  })
);

export { router as scheduleRoutes };
