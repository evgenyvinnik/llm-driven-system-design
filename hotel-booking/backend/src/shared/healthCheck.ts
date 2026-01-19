/**
 * Health Check Module
 *
 * Provides comprehensive health checks for all dependencies:
 * - Database connectivity and pool health
 * - Redis connectivity
 * - Elasticsearch cluster health
 *
 * Supports both simple liveness checks and detailed readiness checks
 */

import { query, pool } from '../models/db.js';
import redis from '../models/redis.js';
import { getClient } from '../models/elasticsearch.js';
import { logger } from './logger.js';
import * as metrics from './metrics.js';
import express, { Router, Request, Response } from 'express';

export interface DatabaseHealthStatus {
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  pool?: {
    total: number;
    idle: number;
    waiting: number;
  };
  error?: string;
}

export interface RedisHealthStatus {
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  error?: string;
}

export interface ElasticsearchHealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  latencyMs: number;
  clusterStatus?: string;
  numberOfNodes?: number;
  activeShards?: number;
  error?: string;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  totalLatencyMs: number;
  dependencies: {
    database: DatabaseHealthStatus;
    cache: RedisHealthStatus;
    search: ElasticsearchHealthStatus;
  };
}

export interface LivenessStatus {
  status: 'alive';
  timestamp: string;
  uptime: number;
  memory: NodeJS.MemoryUsage;
}

export interface ReadinessStatus extends HealthStatus {
  ready: boolean;
}

interface HealthCheckRow {
  health_check: number;
}

/**
 * Check PostgreSQL health
 * @returns Health status
 */
export async function checkDatabase(): Promise<DatabaseHealthStatus> {
  const startTime = Date.now();
  try {
    const result = await query<HealthCheckRow>('SELECT 1 as health_check');

    if (result.rows[0]?.health_check === 1) {
      // Update pool metrics
      metrics.dbPoolActiveConnections.set(pool.totalCount - pool.idleCount);
      metrics.dbPoolIdleConnections.set(pool.idleCount);

      return {
        status: 'healthy',
        latencyMs: Date.now() - startTime,
        pool: {
          total: pool.totalCount,
          idle: pool.idleCount,
          waiting: pool.waitingCount,
        },
      };
    }

    throw new Error('Unexpected query result');
  } catch (error) {
    const err = error as Error;
    logger.error({ error }, 'Database health check failed');
    return {
      status: 'unhealthy',
      error: err.message,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Check Redis health
 * @returns Health status
 */
export async function checkRedis(): Promise<RedisHealthStatus> {
  const startTime = Date.now();
  try {
    const result = await redis.ping();

    if (result === 'PONG') {
      metrics.redisConnectionStatus.set(1);
      return {
        status: 'healthy',
        latencyMs: Date.now() - startTime,
      };
    }

    throw new Error(`Unexpected ping response: ${result}`);
  } catch (error) {
    const err = error as Error;
    logger.error({ error }, 'Redis health check failed');
    metrics.redisConnectionStatus.set(0);
    return {
      status: 'unhealthy',
      error: err.message,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Check Elasticsearch health
 * @returns Health status
 */
export async function checkElasticsearch(): Promise<ElasticsearchHealthStatus> {
  const startTime = Date.now();
  try {
    const client = getClient();
    const health = await client.cluster.health();

    const isHealthy = health.status === 'green' || health.status === 'yellow';
    metrics.elasticsearchConnectionStatus.set(isHealthy ? 1 : 0);

    return {
      status: isHealthy ? 'healthy' : 'degraded',
      clusterStatus: health.status,
      numberOfNodes: health.number_of_nodes,
      activeShards: health.active_shards,
      latencyMs: Date.now() - startTime,
    };
  } catch (error) {
    const err = error as Error;
    logger.error({ error }, 'Elasticsearch health check failed');
    metrics.elasticsearchConnectionStatus.set(0);
    return {
      status: 'unhealthy',
      error: err.message,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Perform full health check on all dependencies
 * @returns Comprehensive health status
 */
export async function checkHealth(): Promise<HealthStatus> {
  const startTime = Date.now();

  const [database, cache, search] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkElasticsearch(),
  ]);

  const allHealthy =
    database.status === 'healthy' &&
    cache.status === 'healthy' &&
    (search.status === 'healthy' || search.status === 'degraded');

  return {
    status: allHealthy ? 'healthy' : 'unhealthy',
    timestamp: new Date().toISOString(),
    totalLatencyMs: Date.now() - startTime,
    dependencies: {
      database,
      cache,
      search,
    },
  };
}

/**
 * Simple liveness check
 * Used by Kubernetes/Docker to determine if process is alive
 * @returns Liveness status
 */
export function livenessCheck(): LivenessStatus {
  return {
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  };
}

/**
 * Readiness check
 * Used by Kubernetes/Docker to determine if service can accept traffic
 * @returns Readiness status
 */
export async function readinessCheck(): Promise<ReadinessStatus> {
  const health = await checkHealth();

  return {
    ready: health.status === 'healthy',
    ...health,
  };
}

/**
 * Express router for health endpoints
 */
export function createHealthRouter(_express: typeof express): Router {
  const router = Router();

  // Simple liveness probe
  router.get('/live', (_req: Request, res: Response) => {
    res.json(livenessCheck());
  });

  // Readiness probe with dependency checks
  router.get('/ready', async (_req: Request, res: Response) => {
    try {
      const status = await readinessCheck();
      res.status(status.ready ? 200 : 503).json(status);
    } catch (error) {
      const err = error as Error;
      logger.error({ error }, 'Readiness check error');
      res.status(503).json({
        ready: false,
        error: err.message,
      });
    }
  });

  // Detailed health check
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const health = await checkHealth();
      res.status(health.status === 'healthy' ? 200 : 503).json(health);
    } catch (error) {
      const err = error as Error;
      logger.error({ error }, 'Health check error');
      res.status(503).json({
        status: 'error',
        error: err.message,
      });
    }
  });

  return router;
}

export default {
  checkDatabase,
  checkRedis,
  checkElasticsearch,
  checkHealth,
  livenessCheck,
  readinessCheck,
  createHealthRouter,
};
