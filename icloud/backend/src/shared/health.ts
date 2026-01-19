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

import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { Client as MinioClient } from 'minio';
import type { Router as ExpressRouter, Request, Response } from 'express';
import { Router } from 'express';
import logger from './logger.js';
import type { StorageCircuitBreakers, StorageHealth } from './circuitBreaker.js';

export interface ComponentHealth {
  status: 'healthy' | 'unhealthy';
  latencyMs: number;
  error?: string;
  poolInfo?: {
    totalCount: number;
    idleCount: number;
    waitingCount: number;
  };
  memoryUsedBytes?: number | null;
  bucketsCount?: number;
}

export interface CircuitBreakerStatus {
  status: 'healthy' | 'degraded' | 'not_configured';
  breakers?: StorageHealth;
}

export interface FullHealth {
  status: 'healthy' | 'unhealthy';
  timestamp: string;
  uptime: number;
  version: string;
  components: {
    postgres: ComponentHealth;
    redis: ComponentHealth;
    storage: ComponentHealth;
    circuitBreakers: CircuitBreakerStatus;
  };
}

export interface Liveness {
  status: 'alive';
  timestamp: string;
}

export interface Readiness {
  status: 'ready' | 'not_ready';
  timestamp: string;
  checks: {
    postgres: 'healthy' | 'unhealthy';
    redis: 'healthy' | 'unhealthy';
  };
}

export interface HealthCheckerDeps {
  pool: Pool;
  redis: Redis;
  minioClient: MinioClient;
  storageBreakers?: StorageCircuitBreakers;
}

/**
 * Health check results with component details
 */
export class HealthChecker {
  private pool: Pool;
  private redis: Redis;
  private minioClient: MinioClient;
  private storageBreakers?: StorageCircuitBreakers;
  private startTime: number;

  constructor({ pool, redis, minioClient, storageBreakers }: HealthCheckerDeps) {
    this.pool = pool;
    this.redis = redis;
    this.minioClient = minioClient;
    this.storageBreakers = storageBreakers;
    this.startTime = Date.now();
  }

  /**
   * Check PostgreSQL connection
   */
  async checkPostgres(): Promise<ComponentHealth> {
    const startTime = Date.now();
    try {
      await this.pool.query('SELECT 1 as health');
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
      logger.error({ error: (error as Error).message }, 'PostgreSQL health check failed');
      return {
        status: 'unhealthy',
        error: (error as Error).message,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Check Redis connection
   */
  async checkRedis(): Promise<ComponentHealth> {
    const startTime = Date.now();
    try {
      const pong = await this.redis.ping();
      const info = await this.redis.info('memory');
      const usedMemoryMatch = info.match(/used_memory:(\d+)/);
      const usedMemory = usedMemoryMatch?.[1];

      return {
        status: pong === 'PONG' ? 'healthy' : 'unhealthy',
        latencyMs: Date.now() - startTime,
        memoryUsedBytes: usedMemory ? parseInt(usedMemory) : null,
      };
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Redis health check failed');
      return {
        status: 'unhealthy',
        error: (error as Error).message,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Check MinIO storage connection
   */
  async checkStorage(): Promise<ComponentHealth> {
    const startTime = Date.now();
    try {
      const buckets = await this.minioClient.listBuckets();
      return {
        status: 'healthy',
        latencyMs: Date.now() - startTime,
        bucketsCount: buckets.length,
      };
    } catch (error) {
      logger.error({ error: (error as Error).message }, 'Storage health check failed');
      return {
        status: 'unhealthy',
        error: (error as Error).message,
        latencyMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get circuit breaker status
   */
  getCircuitBreakerStatus(): CircuitBreakerStatus {
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
  async getFullHealth(): Promise<FullHealth> {
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
  getLiveness(): Liveness {
    return {
      status: 'alive',
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Readiness check (can we accept traffic?)
   */
  async getReadiness(): Promise<Readiness> {
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
export function createHealthRoutes(healthChecker: HealthChecker): ExpressRouter {
  const router = Router();

  // Liveness probe - just checks if the process is running
  router.get('/live', (_req: Request, res: Response) => {
    const health = healthChecker.getLiveness();
    res.json(health);
  });

  // Readiness probe - checks if we can serve traffic
  router.get('/ready', async (_req: Request, res: Response) => {
    const health = await healthChecker.getReadiness();
    const statusCode = health.status === 'ready' ? 200 : 503;
    res.status(statusCode).json(health);
  });

  // Full health check with all component details
  router.get('/', async (_req: Request, res: Response) => {
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
