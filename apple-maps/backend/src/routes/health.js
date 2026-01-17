import { Router } from 'express';
import pool from '../db.js';
import redis from '../redis.js';
import { getCircuitBreakerHealth } from '../shared/circuitBreaker.js';
import { dbConnectionsActive, dbConnectionsIdle } from '../shared/metrics.js';
import logger from '../shared/logger.js';

/**
 * Health Check Router
 *
 * WHY: Comprehensive health checks enable:
 * - Load balancer routing decisions (unhealthy = remove from rotation)
 * - Kubernetes readiness/liveness probes
 * - Operational visibility into system state
 * - Early detection of dependency failures
 *
 * Endpoints:
 * - GET /health - Full health check (all dependencies)
 * - GET /health/live - Liveness probe (is process alive?)
 * - GET /health/ready - Readiness probe (can serve traffic?)
 */

const router = Router();

// Health check timeouts (ms)
const DB_TIMEOUT = 3000;
const REDIS_TIMEOUT = 2000;

/**
 * Check PostgreSQL health
 */
async function checkDatabase() {
  const start = Date.now();

  try {
    // Set query timeout using a promise race
    const queryPromise = pool.query('SELECT 1 as health_check');
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Database health check timeout')), DB_TIMEOUT)
    );

    await Promise.race([queryPromise, timeoutPromise]);

    // Update connection pool metrics
    dbConnectionsActive.set(pool.totalCount - pool.idleCount);
    dbConnectionsIdle.set(pool.idleCount);

    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
      connections: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  } catch (error) {
    logger.error({ error }, 'Database health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: error.message,
    };
  }
}

/**
 * Check Redis health
 */
async function checkRedis() {
  const start = Date.now();

  try {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Redis health check timeout')), REDIS_TIMEOUT)
    );

    const pingPromise = redis.ping();
    await Promise.race([pingPromise, timeoutPromise]);

    // Get Redis info for additional metrics
    const info = await redis.info('memory');
    const usedMemory = info.match(/used_memory:(\d+)/)?.[1];

    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
      memoryUsedBytes: usedMemory ? parseInt(usedMemory) : null,
    };
  } catch (error) {
    logger.error({ error }, 'Redis health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: error.message,
    };
  }
}

/**
 * Check routing graph status
 * Verifies that road network data is loaded and queryable
 */
async function checkRoutingGraph() {
  const start = Date.now();

  try {
    const result = await pool.query(
      'SELECT COUNT(*) as node_count FROM road_nodes'
    );
    const nodeCount = parseInt(result.rows[0].node_count);

    const segmentResult = await pool.query(
      'SELECT COUNT(*) as segment_count FROM road_segments'
    );
    const segmentCount = parseInt(segmentResult.rows[0].segment_count);

    if (nodeCount < 10 || segmentCount < 10) {
      return {
        status: 'degraded',
        latencyMs: Date.now() - start,
        message: 'Road network appears incomplete',
        nodes: nodeCount,
        segments: segmentCount,
      };
    }

    return {
      status: 'healthy',
      latencyMs: Date.now() - start,
      nodes: nodeCount,
      segments: segmentCount,
    };
  } catch (error) {
    logger.error({ error }, 'Routing graph health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: error.message,
    };
  }
}

/**
 * Check traffic data freshness
 */
async function checkTrafficData() {
  const start = Date.now();

  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) as total_segments,
        COUNT(CASE WHEN timestamp > NOW() - INTERVAL '5 minutes' THEN 1 END) as fresh_segments
      FROM (
        SELECT DISTINCT ON (segment_id) segment_id, timestamp
        FROM traffic_flow
        ORDER BY segment_id, timestamp DESC
      ) latest
    `);

    const { total_segments, fresh_segments } = result.rows[0];
    const totalSegments = parseInt(total_segments);
    const freshSegments = parseInt(fresh_segments);
    const freshnessRatio = totalSegments > 0 ? freshSegments / totalSegments : 0;

    let status = 'healthy';
    if (freshnessRatio < 0.5) status = 'degraded';
    if (freshnessRatio < 0.1) status = 'unhealthy';

    return {
      status,
      latencyMs: Date.now() - start,
      totalSegments,
      freshSegments,
      freshnessRatio: Math.round(freshnessRatio * 100) + '%',
    };
  } catch (error) {
    // Traffic data might not exist yet - this is acceptable
    if (error.message.includes('relation') && error.message.includes('does not exist')) {
      return {
        status: 'degraded',
        latencyMs: Date.now() - start,
        message: 'Traffic table not initialized',
      };
    }
    logger.error({ error }, 'Traffic data health check failed');
    return {
      status: 'unhealthy',
      latencyMs: Date.now() - start,
      error: error.message,
    };
  }
}

/**
 * Full health check endpoint
 * GET /health
 */
router.get('/', async (req, res) => {
  const startTime = Date.now();

  // Run all checks in parallel
  const [database, cache, routingGraph, trafficData] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkRoutingGraph(),
    checkTrafficData(),
  ]);

  // Get circuit breaker status
  const circuitBreakers = getCircuitBreakerHealth();

  // Determine overall status
  const checks = { database, cache, routingGraph, trafficData };
  const criticalChecks = [database, cache]; // These must be healthy
  const allCriticalHealthy = criticalChecks.every((c) => c.status === 'healthy');
  const anyUnhealthy = Object.values(checks).some((c) => c.status === 'unhealthy');
  const anyDegraded = Object.values(checks).some((c) => c.status === 'degraded');

  let overallStatus;
  if (!allCriticalHealthy || anyUnhealthy) {
    overallStatus = 'unhealthy';
  } else if (anyDegraded) {
    overallStatus = 'degraded';
  } else {
    overallStatus = 'healthy';
  }

  const statusCode = overallStatus === 'unhealthy' ? 503 : 200;

  res.status(statusCode).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    responseTimeMs: Date.now() - startTime,
    version: process.env.npm_package_version || '1.0.0',
    checks,
    circuitBreakers,
  });
});

/**
 * Liveness probe
 * GET /health/live
 *
 * Returns 200 if the process is running
 * Used by Kubernetes to determine if container should be restarted
 */
router.get('/live', (req, res) => {
  res.json({
    status: 'alive',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

/**
 * Readiness probe
 * GET /health/ready
 *
 * Returns 200 only if the service can handle traffic
 * Used by Kubernetes/load balancer for routing decisions
 */
router.get('/ready', async (req, res) => {
  const database = await checkDatabase();
  const cache = await checkRedis();

  const isReady = database.status === 'healthy' && cache.status === 'healthy';

  if (isReady) {
    res.json({
      status: 'ready',
      timestamp: new Date().toISOString(),
      checks: { database, cache },
    });
  } else {
    res.status(503).json({
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      checks: { database, cache },
    });
  }
});

export default router;
