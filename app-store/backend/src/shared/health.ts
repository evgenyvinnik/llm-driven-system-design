/**
 * @fileoverview Health check module for comprehensive service health monitoring.
 * Provides liveness and readiness probes for Kubernetes-style deployments.
 */

import { Request, Response } from 'express';
import { pool } from '../config/database.js';
import { redis } from '../config/redis.js';
import { esClient } from '../config/elasticsearch.js';
import { isRabbitMQConnected, getQueueDepth, QueueConfig } from './queue.js';
import { getAllCircuitBreakerStats } from './circuitBreaker.js';
import { serviceHealth } from './metrics.js';
import { logger } from './logger.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Health status for an individual component.
 */
interface ComponentHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs?: number;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Overall health check response.
 */
interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  components: {
    postgres: ComponentHealth;
    redis: ComponentHealth;
    elasticsearch: ComponentHealth;
    rabbitmq: ComponentHealth;
  };
  circuitBreakers?: object[];
  queueDepths?: Record<string, number>;
}

// =============================================================================
// Health Check Functions
// =============================================================================

/**
 * Checks PostgreSQL connectivity and basic query performance.
 */
async function checkPostgres(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const result = await pool.query('SELECT 1 as health_check');
    const latencyMs = Date.now() - start;

    // Also check pool status
    const poolStatus = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    serviceHealth.set({ dependency: 'postgres' }, 1);

    return {
      status: 'healthy',
      latencyMs,
      details: { pool: poolStatus },
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    serviceHealth.set({ dependency: 'postgres' }, 0);

    return {
      status: 'unhealthy',
      latencyMs,
      message: (error as Error).message,
    };
  }
}

/**
 * Checks Redis connectivity.
 */
async function checkRedis(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const pong = await redis.ping();
    const latencyMs = Date.now() - start;

    if (pong !== 'PONG') {
      serviceHealth.set({ dependency: 'redis' }, 0);
      return {
        status: 'unhealthy',
        latencyMs,
        message: `Unexpected ping response: ${pong}`,
      };
    }

    // Get memory info
    const info = await redis.info('memory');
    const usedMemory = info.match(/used_memory_human:([^\r\n]+)/)?.[1]?.trim();

    serviceHealth.set({ dependency: 'redis' }, 1);

    return {
      status: 'healthy',
      latencyMs,
      details: { usedMemory },
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    serviceHealth.set({ dependency: 'redis' }, 0);

    return {
      status: 'unhealthy',
      latencyMs,
      message: (error as Error).message,
    };
  }
}

/**
 * Checks Elasticsearch connectivity and cluster health.
 */
async function checkElasticsearch(): Promise<ComponentHealth> {
  const start = Date.now();
  try {
    const health = await esClient.cluster.health({});
    const latencyMs = Date.now() - start;

    const clusterStatus = health.status;

    if (clusterStatus === 'red') {
      serviceHealth.set({ dependency: 'elasticsearch' }, 0);
      return {
        status: 'unhealthy',
        latencyMs,
        message: 'Cluster status is red',
        details: { clusterStatus, nodes: health.number_of_nodes },
      };
    }

    if (clusterStatus === 'yellow') {
      serviceHealth.set({ dependency: 'elasticsearch' }, 1);
      return {
        status: 'degraded',
        latencyMs,
        message: 'Cluster status is yellow',
        details: { clusterStatus, nodes: health.number_of_nodes },
      };
    }

    serviceHealth.set({ dependency: 'elasticsearch' }, 1);

    return {
      status: 'healthy',
      latencyMs,
      details: { clusterStatus, nodes: health.number_of_nodes },
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    serviceHealth.set({ dependency: 'elasticsearch' }, 0);

    return {
      status: 'unhealthy',
      latencyMs,
      message: (error as Error).message,
    };
  }
}

/**
 * Checks RabbitMQ connectivity and queue depths.
 */
async function checkRabbitMQ(): Promise<ComponentHealth & { queueDepths?: Record<string, number> }> {
  const start = Date.now();

  if (!isRabbitMQConnected()) {
    serviceHealth.set({ dependency: 'rabbitmq' }, 0);
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      message: 'Not connected to RabbitMQ',
    };
  }

  try {
    // Check queue depths
    const queueDepths: Record<string, number> = {};

    for (const [, queueName] of Object.entries(QueueConfig.queues)) {
      try {
        const depth = await getQueueDepth(queueName);
        queueDepths[queueName] = depth;
      } catch {
        queueDepths[queueName] = -1; // Unknown
      }
    }

    const latencyMs = Date.now() - start;

    // Check for queue depth warnings
    const deadLetterDepth = queueDepths[QueueConfig.queues.deadLetter] || 0;
    if (deadLetterDepth > 100) {
      serviceHealth.set({ dependency: 'rabbitmq' }, 1);
      return {
        status: 'degraded',
        latencyMs,
        message: `Dead letter queue has ${deadLetterDepth} messages`,
        queueDepths,
      };
    }

    serviceHealth.set({ dependency: 'rabbitmq' }, 1);

    return {
      status: 'healthy',
      latencyMs,
      queueDepths,
    };
  } catch (error) {
    const latencyMs = Date.now() - start;
    serviceHealth.set({ dependency: 'rabbitmq' }, 0);

    return {
      status: 'unhealthy',
      latencyMs,
      message: (error as Error).message,
    };
  }
}

// =============================================================================
// Express Handlers
// =============================================================================

/**
 * Liveness probe - checks if the process is running.
 * Used by Kubernetes to determine if the container should be restarted.
 * Should be very lightweight and never fail unless the process is truly dead.
 *
 * GET /health/live
 */
export async function livenessProbe(req: Request, res: Response): Promise<void> {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}

/**
 * Readiness probe - checks if the service is ready to accept traffic.
 * Used by Kubernetes/load balancers to determine if requests should be routed here.
 * Checks critical dependencies (database, cache).
 *
 * GET /health/ready
 */
export async function readinessProbe(req: Request, res: Response): Promise<void> {
  const postgres = await checkPostgres();
  const redisHealth = await checkRedis();

  // Service is ready if both postgres and redis are healthy
  const isReady = postgres.status === 'healthy' && redisHealth.status !== 'unhealthy';

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    components: {
      postgres,
      redis: redisHealth,
    },
  });
}

/**
 * Comprehensive health check - checks all dependencies.
 * Used for detailed monitoring and debugging.
 *
 * GET /health
 */
export async function healthCheck(req: Request, res: Response): Promise<void> {
  const startTime = Date.now();

  // Run all checks in parallel
  const [postgres, redisHealth, elasticsearch, rabbitmq] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkElasticsearch(),
    checkRabbitMQ(),
  ]);

  // Determine overall status
  const components = { postgres, redis: redisHealth, elasticsearch, rabbitmq };
  const statuses = Object.values(components).map((c) => c.status);

  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
  if (statuses.includes('unhealthy')) {
    // Critical dependencies (postgres, redis) being unhealthy = unhealthy
    if (postgres.status === 'unhealthy' || redisHealth.status === 'unhealthy') {
      overallStatus = 'unhealthy';
    } else {
      // Non-critical dependencies (ES, RabbitMQ) being unhealthy = degraded
      overallStatus = 'degraded';
    }
  } else if (statuses.includes('degraded')) {
    overallStatus = 'degraded';
  }

  const response: HealthCheckResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    components,
    circuitBreakers: getAllCircuitBreakerStats(),
    queueDepths: rabbitmq.queueDepths,
  };

  // Log health check if degraded or unhealthy
  if (overallStatus !== 'healthy') {
    logger.warn({ healthCheck: response }, 'Health check returned non-healthy status');
  }

  res.status(overallStatus === 'unhealthy' ? 503 : 200).json(response);
}

/**
 * Simple health check for basic monitoring.
 * Returns OK if the server is running.
 *
 * GET /api/v1/health
 */
export async function simpleHealthCheck(req: Request, res: Response): Promise<void> {
  const postgres = await checkPostgres();

  if (postgres.status !== 'healthy') {
    res.status(503).json({
      status: 'error',
      message: 'Database unavailable',
      timestamp: new Date().toISOString(),
    });
    return;
  }

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
}
