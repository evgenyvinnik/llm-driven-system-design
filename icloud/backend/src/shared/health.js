/**
 * Health check module with detailed status
 *
 * WHY: Comprehensive health checks enable Kubernetes liveness/readiness probes
 * and load balancer health checks. Detailed component status helps with debugging
 * and monitoring. Different endpoints serve different purposes:
 * - /health/live: Basic liveness (is the process running?)
 * - /health/ready: Readiness (can we serve traffic?)
 * - /health: Detailed status of all dependencies
 */

import logger from './logger.js';

/**
 * Health check results with component details
 */
export class HealthChecker {
  constructor({ pool, redis, minioClient, storageBreakers }) {
    this.pool = pool;
    this.redis = redis;
    this.minioClient = minioClient;
    this.storageBreakers = storageBreakers;
    this.startTime = Date.now();
  }

  /**
   * Check PostgreSQL connection
   */
  async checkPostgres() {
    const startTime = Date.now();
    try {
      const result = await this.pool.query('SELECT 1 as health');
      return {
        status: 'healthy',
        latencyMs: Date.now() - startTime,
        poolInfo: {
          totalCount: this.pool.totalCount,
          idleCount: this.pool.idleCount,
          waitingCount: this.pool.waitingCount,
        },
      };
    } catch (error) {
      logger.error({ error: error.message }, 'PostgreSQL health check failed');
      return {
        status: 'unhealthy',
        error: error.message,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Check Redis connection
   */
  async checkRedis() {
    const startTime = Date.now();
    try {
      const pong = await this.redis.ping();
      const info = await this.redis.info('memory');
      const usedMemory = info.match(/used_memory:(\d+)/)?.[1];

      return {
        status: pong === 'PONG' ? 'healthy' : 'unhealthy',
        latencyMs: Date.now() - startTime,
        memoryUsedBytes: usedMemory ? parseInt(usedMemory) : null,
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Redis health check failed');
      return {
        status: 'unhealthy',
        error: error.message,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Check MinIO storage connection
   */
  async checkStorage() {
    const startTime = Date.now();
    try {
      const buckets = await this.minioClient.listBuckets();
      return {
        status: 'healthy',
        latencyMs: Date.now() - startTime,
        bucketsCount: buckets.length,
      };
    } catch (error) {
      logger.error({ error: error.message }, 'Storage health check failed');
      return {
        status: 'unhealthy',
        error: error.message,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus() {
    if (!this.storageBreakers) {
      return { status: 'not_configured' };
    }

    const health = this.storageBreakers.getHealth();
    const allHealthy = this.storageBreakers.isHealthy();

    return {
      status: allHealthy ? 'healthy' : 'degraded',
      breakers: health,
    };
  }

  /**
   * Run all health checks
   */
  async getFullHealth() {
    const [postgres, redis, storage] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
      this.checkStorage(),
    ]);

    const circuitBreakers = this.getCircuitBreakerStatus();

    const components = {
      postgres,
      redis,
      storage,
      circuitBreakers,
    };

    // Overall status is unhealthy if any critical component is unhealthy
    const isHealthy =
      postgres.status === 'healthy' &&
      redis.status === 'healthy' &&
      storage.status === 'healthy';

    return {
      status: isHealthy ? 'healthy' : 'unhealthy',
      timestamp: new Date().toISOString(),
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      version: process.env.APP_VERSION || '1.0.0',
      components,
    };
  }

  /**
   * Simple liveness check (is the process running?)
   */
  getLiveness() {
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness check (can we accept traffic?)
   */
  async getReadiness() {
    const [postgres, redis] = await Promise.all([
      this.checkPostgres(),
      this.checkRedis(),
    ]);

    const isReady =
      postgres.status === 'healthy' && redis.status === 'healthy';

    return {
      status: isReady ? 'ready' : 'not_ready',
      timestamp: new Date().toISOString(),
      checks: {
        postgres: postgres.status,
        redis: redis.status,
      },
    };
  }
}

/**
 * Create health check routes for Express
 */
export function createHealthRoutes(healthChecker) {
  const { Router } = require('express');
  const router = Router();

  // Liveness probe - just checks if the process is running
  router.get('/live', (req, res) => {
    const health = healthChecker.getLiveness();
    res.json(health);
  });

  // Readiness probe - checks if we can serve traffic
  router.get('/ready', async (req, res) => {
    const health = await healthChecker.getReadiness();
    const statusCode = health.status === 'ready' ? 200 : 503;
    res.status(statusCode).json(health);
  });

  // Full health check with all component details
  router.get('/', async (req, res) => {
    const health = await healthChecker.getFullHealth();
    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(health);
  });

  return router;
}

export default {
  HealthChecker,
  createHealthRoutes,
};
