import { pool, redis, testDatabaseConnection, testRedisConnection } from '../db/index.js';
import { logger } from './logger.js';
import { ALERT_THRESHOLDS } from './config.js';
import { queueService, QUEUES } from './queue.js';

/**
 * Health check status levels.
 */
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

/**
 * Individual component health check result.
 */
export interface ComponentHealth {
  status: HealthStatus;
  message?: string;
  latencyMs?: number;
  details?: Record<string, unknown>;
}

/**
 * Overall system health check response.
 */
export interface HealthCheckResponse {
  status: HealthStatus;
  timestamp: string;
  version: string;
  uptime: number;
  components: {
    database: ComponentHealth;
    redis: ComponentHealth;
    rabbitmq: ComponentHealth;
    memory: ComponentHealth;
  };
}

/**
 * Detailed health check response with additional metrics.
 */
export interface DetailedHealthCheckResponse extends HealthCheckResponse {
  components: {
    database: ComponentHealth & {
      poolSize?: number;
      idleConnections?: number;
      waitingConnections?: number;
    };
    redis: ComponentHealth & {
      memoryUsed?: number;
      connectedClients?: number;
    };
    rabbitmq: ComponentHealth & {
      queues?: {
        [key: string]: number | null;
      };
    };
    memory: ComponentHealth & {
      heapUsed?: number;
      heapTotal?: number;
      rss?: number;
    };
  };
}

/**
 * Application start time for uptime calculation.
 */
const startTime = Date.now();

/**
 * Application version from package.json or environment.
 */
const appVersion = process.env.npm_package_version || '1.0.0';

/**
 * Checks PostgreSQL database health.
 * Verifies connection pool status and query latency.
 */
async function checkDatabaseHealth(): Promise<ComponentHealth & {
  poolSize?: number;
  idleConnections?: number;
  waitingConnections?: number;
}> {
  const start = Date.now();

  try {
    const isConnected = await testDatabaseConnection();
    const latencyMs = Date.now() - start;

    // Get pool stats
    const poolStats = {
      poolSize: pool.totalCount,
      idleConnections: pool.idleCount,
      waitingConnections: pool.waitingCount,
    };

    if (!isConnected) {
      return {
        status: 'unhealthy',
        message: 'Database connection failed',
        latencyMs,
        ...poolStats,
      };
    }

    // Check if pool is under pressure
    if (pool.waitingCount > 0) {
      return {
        status: 'degraded',
        message: 'Database connection pool under pressure',
        latencyMs,
        ...poolStats,
      };
    }

    // Check latency threshold
    if (latencyMs > ALERT_THRESHOLDS.DATABASE.CONNECTION_TIMEOUT_MS / 2) {
      return {
        status: 'degraded',
        message: 'Database latency elevated',
        latencyMs,
        ...poolStats,
      };
    }

    return {
      status: 'healthy',
      latencyMs,
      ...poolStats,
    };
  } catch (error) {
    logger.error({ error }, 'Database health check failed');
    return {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Checks Redis/Valkey health.
 * Verifies connection and memory usage.
 */
async function checkRedisHealth(): Promise<ComponentHealth & {
  memoryUsed?: number;
  connectedClients?: number;
}> {
  const start = Date.now();

  try {
    const isConnected = await testRedisConnection();
    const latencyMs = Date.now() - start;

    if (!isConnected) {
      return {
        status: 'unhealthy',
        message: 'Redis connection failed',
        latencyMs,
      };
    }

    // Get Redis info for detailed health
    const info = await redis.info('memory');
    const memoryMatch = info.match(/used_memory:(\d+)/);
    const memoryUsed = memoryMatch ? parseInt(memoryMatch[1]) : undefined;

    // Check memory thresholds
    if (memoryUsed) {
      if (memoryUsed > ALERT_THRESHOLDS.STORAGE.REDIS_CRITICAL_BYTES) {
        return {
          status: 'unhealthy',
          message: 'Redis memory usage critical',
          latencyMs,
          memoryUsed,
        };
      }
      if (memoryUsed > ALERT_THRESHOLDS.STORAGE.REDIS_WARNING_BYTES) {
        return {
          status: 'degraded',
          message: 'Redis memory usage elevated',
          latencyMs,
          memoryUsed,
        };
      }
    }

    return {
      status: 'healthy',
      latencyMs,
      memoryUsed,
    };
  } catch (error) {
    logger.error({ error }, 'Redis health check failed');
    return {
      status: 'unhealthy',
      message: error instanceof Error ? error.message : 'Unknown error',
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Checks RabbitMQ health.
 * Verifies connection status and queue depths.
 */
async function checkRabbitMQHealth(): Promise<ComponentHealth & {
  queues?: { [key: string]: number | null };
}> {
  const start = Date.now();

  try {
    const isHealthy = queueService.isHealthy();
    const latencyMs = Date.now() - start;

    if (!isHealthy) {
      return {
        status: 'unhealthy',
        message: 'RabbitMQ connection not established',
        latencyMs,
      };
    }

    // Get queue depths
    const [notificationsDepth, remindersDepth, dlqDepth] = await Promise.all([
      queueService.getQueueDepth(QUEUES.BOOKING_NOTIFICATIONS),
      queueService.getQueueDepth(QUEUES.REMINDERS),
      queueService.getQueueDepth(QUEUES.DLQ),
    ]);

    const queues = {
      [QUEUES.BOOKING_NOTIFICATIONS]: notificationsDepth,
      [QUEUES.REMINDERS]: remindersDepth,
      [QUEUES.DLQ]: dlqDepth,
    };

    // Check queue depth thresholds
    if (dlqDepth !== null && dlqDepth > ALERT_THRESHOLDS.QUEUE.DLQ_CRITICAL) {
      return {
        status: 'unhealthy',
        message: 'Dead letter queue depth critical',
        latencyMs,
        queues,
      };
    }

    if (notificationsDepth !== null && notificationsDepth > ALERT_THRESHOLDS.QUEUE.NOTIFICATION_QUEUE_CRITICAL) {
      return {
        status: 'unhealthy',
        message: 'Notification queue depth critical',
        latencyMs,
        queues,
      };
    }

    if (dlqDepth !== null && dlqDepth > ALERT_THRESHOLDS.QUEUE.DLQ_WARNING) {
      return {
        status: 'degraded',
        message: 'Dead letter queue depth elevated',
        latencyMs,
        queues,
      };
    }

    if (notificationsDepth !== null && notificationsDepth > ALERT_THRESHOLDS.QUEUE.NOTIFICATION_QUEUE_WARNING) {
      return {
        status: 'degraded',
        message: 'Notification queue depth elevated',
        latencyMs,
        queues,
      };
    }

    return {
      status: 'healthy',
      latencyMs,
      queues,
    };
  } catch (error) {
    logger.error({ error }, 'RabbitMQ health check failed');
    return {
      status: 'degraded',
      message: error instanceof Error ? error.message : 'Unknown error',
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Checks Node.js process memory health.
 * Monitors heap usage for potential memory leaks.
 */
function checkMemoryHealth(): ComponentHealth & {
  heapUsed?: number;
  heapTotal?: number;
  rss?: number;
} {
  const memoryUsage = process.memoryUsage();

  // Consider unhealthy if heap usage exceeds 90%
  const heapUsagePercent = memoryUsage.heapUsed / memoryUsage.heapTotal;

  if (heapUsagePercent > 0.9) {
    return {
      status: 'unhealthy',
      message: 'Heap memory usage critical (>90%)',
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      rss: memoryUsage.rss,
    };
  }

  if (heapUsagePercent > 0.8) {
    return {
      status: 'degraded',
      message: 'Heap memory usage elevated (>80%)',
      heapUsed: memoryUsage.heapUsed,
      heapTotal: memoryUsage.heapTotal,
      rss: memoryUsage.rss,
    };
  }

  return {
    status: 'healthy',
    heapUsed: memoryUsage.heapUsed,
    heapTotal: memoryUsage.heapTotal,
    rss: memoryUsage.rss,
  };
}

/**
 * Determines overall health status from component statuses.
 * RabbitMQ is considered optional - degraded status if unavailable.
 */
function determineOverallStatus(components: {
  database: ComponentHealth;
  redis: ComponentHealth;
  rabbitmq: ComponentHealth;
  memory: ComponentHealth;
}): HealthStatus {
  // Database and Redis are critical
  const criticalStatuses = [
    components.database.status,
    components.redis.status,
    components.memory.status,
  ];

  if (criticalStatuses.includes('unhealthy')) {
    return 'unhealthy';
  }

  // RabbitMQ unhealthy only degrades overall status (async processing can retry)
  if (components.rabbitmq.status === 'unhealthy') {
    return 'degraded';
  }

  if (criticalStatuses.includes('degraded') || components.rabbitmq.status === 'degraded') {
    return 'degraded';
  }

  return 'healthy';
}

/**
 * Performs a basic health check.
 * Returns minimal information suitable for load balancers.
 */
export async function performHealthCheck(): Promise<HealthCheckResponse> {
  const [database, redisHealth, rabbitmqHealth] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkRabbitMQHealth(),
  ]);

  const memory = checkMemoryHealth();

  const components = {
    database: {
      status: database.status,
      message: database.message,
      latencyMs: database.latencyMs,
    },
    redis: {
      status: redisHealth.status,
      message: redisHealth.message,
      latencyMs: redisHealth.latencyMs,
    },
    rabbitmq: {
      status: rabbitmqHealth.status,
      message: rabbitmqHealth.message,
      latencyMs: rabbitmqHealth.latencyMs,
    },
    memory: {
      status: memory.status,
      message: memory.message,
    },
  };

  return {
    status: determineOverallStatus(components),
    timestamp: new Date().toISOString(),
    version: appVersion,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    components,
  };
}

/**
 * Performs a detailed health check.
 * Returns comprehensive information for debugging and monitoring.
 */
export async function performDetailedHealthCheck(): Promise<DetailedHealthCheckResponse> {
  const [database, redisHealth, rabbitmqHealth] = await Promise.all([
    checkDatabaseHealth(),
    checkRedisHealth(),
    checkRabbitMQHealth(),
  ]);

  const memory = checkMemoryHealth();

  const components = { database, redis: redisHealth, rabbitmq: rabbitmqHealth, memory };

  return {
    status: determineOverallStatus(components),
    timestamp: new Date().toISOString(),
    version: appVersion,
    uptime: Math.floor((Date.now() - startTime) / 1000),
    components,
  };
}

/**
 * Liveness probe for Kubernetes.
 * Returns true if the application process is running.
 */
export function isAlive(): boolean {
  return true;
}

/**
 * Readiness probe for Kubernetes.
 * Returns true if the application is ready to accept traffic.
 */
export async function isReady(): Promise<boolean> {
  const health = await performHealthCheck();
  return health.status !== 'unhealthy';
}

export default {
  performHealthCheck,
  performDetailedHealthCheck,
  isAlive,
  isReady,
};
