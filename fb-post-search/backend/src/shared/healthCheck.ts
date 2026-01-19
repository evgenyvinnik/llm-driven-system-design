/**
 * @fileoverview Comprehensive health check service.
 * Performs deep health checks on all dependencies and exposes detailed status.
 * Used by load balancers, monitoring systems, and admin endpoints.
 */

import { esClient, POSTS_INDEX } from '../config/elasticsearch.js';
import { pool } from '../config/database.js';
import { redis } from '../config/redis.js';
import { logger, logHealthCheck } from './logger.js';
import {
  elasticsearchDocsCount,
  elasticsearchIndexSizeBytes,
  dbConnectionsActive,
} from './metrics.js';
import { isElasticsearchCircuitOpen, getElasticsearchCircuitState } from './circuitBreaker.js';
import {
  ELASTICSEARCH_THRESHOLDS,
  POSTGRES_THRESHOLDS,
  REDIS_THRESHOLDS,
} from './alertThresholds.js';

/**
 * Health status for an individual service.
 */
export interface ServiceHealth {
  healthy: boolean;
  latencyMs: number;
  message?: string;
  details?: Record<string, unknown>;
}

/**
 * Comprehensive health check result.
 */
export interface HealthCheckResult {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  services: {
    postgres: ServiceHealth;
    elasticsearch: ServiceHealth;
    redis: ServiceHealth;
  };
  circuitBreakers: {
    elasticsearch: string;
  };
}

/**
 * Application start time for uptime calculation.
 */
const startTime = Date.now();

/**
 * Checks PostgreSQL health.
 * Verifies connectivity and measures query latency.
 */
async function checkPostgres(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    const latencyMs = Date.now() - start;

    // Get connection pool stats
    const totalCount = pool.totalCount;
    const idleCount = pool.idleCount;
    const waitingCount = pool.waitingCount;

    // Update metrics
    dbConnectionsActive.set(totalCount - idleCount);

    // Check thresholds
    const activeConnections = totalCount - idleCount;
    let message: string | undefined;
    if (activeConnections > POSTGRES_THRESHOLDS.CONNECTIONS_WARNING) {
      message = `High connection count: ${activeConnections}`;
    }
    if (latencyMs > POSTGRES_THRESHOLDS.QUERY_LATENCY_WARNING * 1000) {
      message = `High latency: ${latencyMs}ms`;
    }

    return {
      healthy: true,
      latencyMs,
      message,
      details: {
        totalConnections: totalCount,
        idleConnections: idleCount,
        waitingClients: waitingCount,
      },
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Checks Elasticsearch health.
 * Verifies cluster health, connectivity, and index status.
 */
async function checkElasticsearch(): Promise<ServiceHealth> {
  const start = Date.now();

  // Check circuit breaker first
  if (isElasticsearchCircuitOpen()) {
    return {
      healthy: false,
      latencyMs: 0,
      message: 'Circuit breaker is open',
      details: {
        circuitState: getElasticsearchCircuitState(),
      },
    };
  }

  try {
    // Ping cluster
    await esClient.ping();

    // Get cluster health
    const clusterHealth = await esClient.cluster.health();

    // Get index stats
    let indexStats = null;
    try {
      const stats = await esClient.indices.stats({ index: POSTS_INDEX });
      indexStats = {
        docsCount: stats._all.primaries?.docs?.count || 0,
        storeSizeBytes: stats._all.primaries?.store?.size_in_bytes || 0,
      };

      // Update metrics
      elasticsearchDocsCount.set(indexStats.docsCount);
      elasticsearchIndexSizeBytes.set(indexStats.storeSizeBytes);
    } catch {
      // Index might not exist yet
    }

    const latencyMs = Date.now() - start;

    // Determine health based on cluster status
    const healthy = clusterHealth.status !== 'red';
    let message: string | undefined;
    if (clusterHealth.status === 'yellow') {
      message = 'Cluster status is yellow (some replicas unassigned)';
    } else if (clusterHealth.status === 'red') {
      message = 'Cluster status is red (primary shards unassigned)';
    }

    return {
      healthy,
      latencyMs,
      message,
      details: {
        clusterName: clusterHealth.cluster_name,
        clusterStatus: clusterHealth.status,
        numberOfNodes: clusterHealth.number_of_nodes,
        activeShards: clusterHealth.active_shards,
        ...indexStats,
      },
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Checks Redis health.
 * Verifies connectivity and memory usage.
 */
async function checkRedis(): Promise<ServiceHealth> {
  const start = Date.now();
  try {
    await redis.ping();

    // Get memory info
    const info = await redis.info('memory');
    const usedMemory = parseInt(info.match(/used_memory:(\d+)/)?.[1] || '0', 10);
    const maxMemory = parseInt(info.match(/maxmemory:(\d+)/)?.[1] || '0', 10);

    const latencyMs = Date.now() - start;

    let message: string | undefined;
    if (maxMemory > 0) {
      const memoryUsage = usedMemory / maxMemory;
      if (memoryUsage > REDIS_THRESHOLDS.MEMORY_USAGE_WARNING) {
        message = `High memory usage: ${(memoryUsage * 100).toFixed(1)}%`;
      }
    }

    return {
      healthy: true,
      latencyMs,
      message,
      details: {
        usedMemoryBytes: usedMemory,
        maxMemoryBytes: maxMemory || 'unlimited',
        status: redis.status,
      },
    };
  } catch (error) {
    return {
      healthy: false,
      latencyMs: Date.now() - start,
      message: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Performs a comprehensive health check of all services.
 * @returns Full health check result with all service statuses
 */
export async function performHealthCheck(): Promise<HealthCheckResult> {
  const [postgres, elasticsearch, redisHealth] = await Promise.all([
    checkPostgres(),
    checkElasticsearch(),
    checkRedis(),
  ]);

  const services = {
    postgres,
    elasticsearch,
    redis: redisHealth,
  };

  // Determine overall status
  const allHealthy = Object.values(services).every((s) => s.healthy);
  const anyUnhealthy = Object.values(services).some((s) => !s.healthy);

  let status: 'healthy' | 'degraded' | 'unhealthy';
  if (allHealthy) {
    status = 'healthy';
  } else if (anyUnhealthy && !postgres.healthy) {
    // PostgreSQL is critical - if it's down, we're unhealthy
    status = 'unhealthy';
  } else {
    status = 'degraded';
  }

  const result: HealthCheckResult = {
    status,
    timestamp: new Date().toISOString(),
    uptime: Date.now() - startTime,
    services,
    circuitBreakers: {
      elasticsearch: getElasticsearchCircuitState(),
    },
  };

  // Log health check result
  logHealthCheck(
    {
      postgres: postgres.healthy,
      elasticsearch: elasticsearch.healthy,
      redis: redisHealth.healthy,
    },
    status === 'healthy' ? 'ok' : 'degraded'
  );

  return result;
}

/**
 * Performs a lightweight liveness check.
 * Only verifies the application is running, not dependencies.
 * @returns Simple liveness status
 */
export function livenessCheck(): { alive: boolean; uptime: number } {
  return {
    alive: true,
    uptime: Date.now() - startTime,
  };
}

/**
 * Performs a readiness check for load balancer integration.
 * Returns true only if all critical services are healthy.
 * @returns Whether the service is ready to accept traffic
 */
export async function readinessCheck(): Promise<boolean> {
  const health = await performHealthCheck();
  return health.status !== 'unhealthy';
}
