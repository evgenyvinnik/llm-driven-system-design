import { redis } from '../models/redis.js';
import { esClient } from '../models/elasticsearch.js';
import { db } from '../models/db.js';
import { getCircuitBreakerStatus } from './circuitBreaker.js';
import { config } from '../config/index.js';

/**
 * Health Check Module
 *
 * Provides comprehensive health status for:
 * - Basic liveness (is the process running)
 * - Readiness (can we serve traffic)
 * - Dependency health (Redis, Elasticsearch, PostgreSQL)
 * - Circuit breaker status
 */

/**
 * Check Redis connectivity
 */
const checkRedis = async () => {
  try {
    const start = Date.now();
    await redis.ping();
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
    };
  }
};

/**
 * Check Elasticsearch connectivity
 */
const checkElasticsearch = async () => {
  try {
    const start = Date.now();
    const health = await esClient.cluster.health();
    return {
      status: health.status === 'red' ? 'degraded' : 'healthy',
      clusterStatus: health.status,
      latencyMs: Date.now() - start,
      nodeCount: health.number_of_nodes,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
    };
  }
};

/**
 * Check PostgreSQL connectivity
 */
const checkPostgres = async () => {
  try {
    const start = Date.now();
    const result = await db.query('SELECT 1 as health');
    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      error: error.message,
    };
  }
};

/**
 * Liveness probe - is the process alive?
 * Used by Kubernetes liveness probe
 */
export const livenessHandler = (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
};

/**
 * Readiness probe - can the service handle traffic?
 * Checks all critical dependencies
 */
export const readinessHandler = async (req, res) => {
  try {
    const [redisHealth, esHealth, pgHealth] = await Promise.all([
      checkRedis(),
      checkElasticsearch(),
      checkPostgres(),
    ]);

    const isReady =
      redisHealth.status === 'healthy' &&
      esHealth.status !== 'unhealthy' &&
      pgHealth.status === 'healthy';

    const status = {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      dependencies: {
        redis: redisHealth,
        elasticsearch: esHealth,
        postgres: pgHealth,
      },
    };

    res.status(isReady ? 200 : 503).json(status);
  } catch (error) {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
};

/**
 * Full health check - comprehensive system status
 * For admin/monitoring dashboards
 */
export const healthHandler = async (req, res) => {
  try {
    const [redisHealth, esHealth, pgHealth] = await Promise.all([
      checkRedis(),
      checkElasticsearch(),
      checkPostgres(),
    ]);

    const circuitBreakers = getCircuitBreakerStatus();

    const allHealthy =
      redisHealth.status === 'healthy' &&
      esHealth.status !== 'unhealthy' &&
      pgHealth.status === 'healthy';

    const status = {
      status: allHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      port: config.port,
      environment: config.nodeEnv,
      dependencies: {
        redis: redisHealth,
        elasticsearch: esHealth,
        postgres: pgHealth,
      },
      circuitBreakers,
      memory: {
        heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
        rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
    };

    res.status(allHealthy ? 200 : 503).json(status);
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
};
