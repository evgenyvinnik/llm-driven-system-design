import type { Express, Request, Response } from 'express';
import { query } from './db.js';
import redis from './redis.js';
import { isHealthy as isRabbitMQHealthy } from './queue.js';
import { getCircuitBreakerStatus } from './circuitBreaker.js';
import { createLogger } from './logger.js';
import { metrics } from './metrics.js';
import type { ServiceHealth, HealthStatus, LivenessStatus, ReadinessStatus } from '../types/index.js';

const logger = createLogger('health');

/**
 * Check PostgreSQL health
 * @returns Service health status
 */
async function checkPostgres(): Promise<ServiceHealth> {
  const startTime = Date.now();

  try {
    const result = await query<{ health_check: number }>('SELECT 1 as health_check');
    const latency = Date.now() - startTime;

    if (result.rows.length > 0) {
      metrics.serviceHealthGauge.set({ service: 'postgres' }, 1);
      return {
        status: 'healthy',
        latency,
      };
    }

    metrics.serviceHealthGauge.set({ service: 'postgres' }, 0);
    return {
      status: 'unhealthy',
      error: 'No response from query',
      latency,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    const err = error as Error;
    metrics.serviceHealthGauge.set({ service: 'postgres' }, 0);
    return {
      status: 'unhealthy',
      error: err.message,
      latency,
    };
  }
}

/**
 * Check Redis health
 * @returns Service health status
 */
async function checkRedis(): Promise<ServiceHealth> {
  const startTime = Date.now();

  try {
    const result = await redis.ping();
    const latency = Date.now() - startTime;

    if (result === 'PONG') {
      metrics.serviceHealthGauge.set({ service: 'redis' }, 1);
      return {
        status: 'healthy',
        latency,
      };
    }

    metrics.serviceHealthGauge.set({ service: 'redis' }, 0);
    return {
      status: 'unhealthy',
      error: `Unexpected response: ${result}`,
      latency,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    const err = error as Error;
    metrics.serviceHealthGauge.set({ service: 'redis' }, 0);
    return {
      status: 'unhealthy',
      error: err.message,
      latency,
    };
  }
}

/**
 * Check RabbitMQ health
 * @returns Service health status
 */
async function checkRabbitMQ(): Promise<ServiceHealth> {
  const startTime = Date.now();

  try {
    const healthy = await isRabbitMQHealthy();
    const latency = Date.now() - startTime;

    if (healthy) {
      metrics.serviceHealthGauge.set({ service: 'rabbitmq' }, 1);
      return {
        status: 'healthy',
        latency,
      };
    }

    metrics.serviceHealthGauge.set({ service: 'rabbitmq' }, 0);
    return {
      status: 'unhealthy',
      error: 'RabbitMQ connection not available',
      latency,
    };
  } catch (error) {
    const latency = Date.now() - startTime;
    const err = error as Error;
    metrics.serviceHealthGauge.set({ service: 'rabbitmq' }, 0);
    return {
      status: 'unhealthy',
      error: err.message,
      latency,
    };
  }
}

/**
 * Get overall health status
 * @returns Complete health status
 */
export async function getHealthStatus(): Promise<HealthStatus> {
  const startTime = Date.now();

  // Run all health checks in parallel
  const [postgres, redisHealth, rabbitmq] = await Promise.all([
    checkPostgres(),
    checkRedis(),
    checkRabbitMQ(),
  ]);

  // Get circuit breaker status
  const circuitBreakers = getCircuitBreakerStatus();

  // Determine overall status
  const services = { postgres, redis: redisHealth, rabbitmq };

  // System is degraded if any service is unhealthy
  // System is healthy only if all critical services are healthy
  const criticalServices = ['postgres', 'redis'] as const;
  const allCriticalHealthy = criticalServices.every(
    (s) => services[s]?.status === 'healthy'
  );

  const allHealthy = Object.values(services).every((s) => s.status === 'healthy');

  let overallStatus: 'healthy' | 'unhealthy' | 'degraded';
  if (allHealthy) {
    overallStatus = 'healthy';
  } else if (allCriticalHealthy) {
    overallStatus = 'degraded';
  } else {
    overallStatus = 'unhealthy';
  }

  const totalLatency = Date.now() - startTime;

  return {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: '1.0.0',
    totalLatency,
    services,
    circuitBreakers,
    memory: {
      heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
    },
  };
}

/**
 * Simple liveness check (is the process running?)
 * @returns Liveness status
 */
export function getLivenessStatus(): LivenessStatus {
  return {
    status: 'ok',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Readiness check (is the service ready to accept traffic?)
 * @returns Readiness status
 */
export async function getReadinessStatus(): Promise<ReadinessStatus> {
  const [postgres, redisHealth] = await Promise.all([checkPostgres(), checkRedis()]);

  const isReady = postgres.status === 'healthy' && redisHealth.status === 'healthy';

  return {
    ready: isReady,
    timestamp: new Date().toISOString(),
    checks: {
      postgres: postgres.status,
      redis: redisHealth.status,
    },
  };
}

/**
 * Health check router handler
 */
export function healthRouter(app: Express): void {
  // Detailed health check
  app.get('/health', async (_req: Request, res: Response): Promise<void> => {
    try {
      const health = await getHealthStatus();

      const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;

      res.status(statusCode).json(health);
    } catch (error) {
      const err = error as Error;
      logger.error({ error: err.message }, 'Health check failed');
      res.status(503).json({
        status: 'unhealthy',
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Simple liveness probe (for Kubernetes)
  app.get('/health/live', (_req: Request, res: Response): void => {
    res.json(getLivenessStatus());
  });

  // Readiness probe (for Kubernetes)
  app.get('/health/ready', async (_req: Request, res: Response): Promise<void> => {
    try {
      const readiness = await getReadinessStatus();
      const statusCode = readiness.ready ? 200 : 503;
      res.status(statusCode).json(readiness);
    } catch (error) {
      const err = error as Error;
      res.status(503).json({
        ready: false,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
    }
  });
}

export default {
  getHealthStatus,
  getLivenessStatus,
  getReadinessStatus,
  healthRouter,
};
