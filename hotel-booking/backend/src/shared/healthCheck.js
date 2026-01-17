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

const db = require('../models/db');
const redis = require('../models/redis');
const elasticsearch = require('../models/elasticsearch');
const { logger } = require('./logger');
const metrics = require('./metrics');

/**
 * Check PostgreSQL health
 * @returns {Object} Health status
 */
async function checkDatabase() {
  const startTime = Date.now();
  try {
    const result = await db.query('SELECT 1 as health_check');

    if (result.rows[0]?.health_check === 1) {
      // Update pool metrics
      const pool = db.pool;
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
    logger.error({ error }, 'Database health check failed');
    return {
      status: 'unhealthy',
      error: error.message,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Check Redis health
 * @returns {Object} Health status
 */
async function checkRedis() {
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
    logger.error({ error }, 'Redis health check failed');
    metrics.redisConnectionStatus.set(0);
    return {
      status: 'unhealthy',
      error: error.message,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Check Elasticsearch health
 * @returns {Object} Health status
 */
async function checkElasticsearch() {
  const startTime = Date.now();
  try {
    const client = elasticsearch.getClient();
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
    logger.error({ error }, 'Elasticsearch health check failed');
    metrics.elasticsearchConnectionStatus.set(0);
    return {
      status: 'unhealthy',
      error: error.message,
      latencyMs: Date.now() - startTime,
    };
  }
}

/**
 * Perform full health check on all dependencies
 * @returns {Object} Comprehensive health status
 */
async function checkHealth() {
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
 * @returns {Object} Liveness status
 */
function livenessCheck() {
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
 * @returns {Object} Readiness status
 */
async function readinessCheck() {
  const health = await checkHealth();

  return {
    ready: health.status === 'healthy',
    ...health,
  };
}

/**
 * Express router for health endpoints
 */
function createHealthRouter(express) {
  const router = express.Router();

  // Simple liveness probe
  router.get('/live', (req, res) => {
    res.json(livenessCheck());
  });

  // Readiness probe with dependency checks
  router.get('/ready', async (req, res) => {
    try {
      const status = await readinessCheck();
      res.status(status.ready ? 200 : 503).json(status);
    } catch (error) {
      logger.error({ error }, 'Readiness check error');
      res.status(503).json({
        ready: false,
        error: error.message,
      });
    }
  });

  // Detailed health check
  router.get('/', async (req, res) => {
    try {
      const health = await checkHealth();
      res.status(health.status === 'healthy' ? 200 : 503).json(health);
    } catch (error) {
      logger.error({ error }, 'Health check error');
      res.status(503).json({
        status: 'error',
        error: error.message,
      });
    }
  });

  return router;
}

module.exports = {
  checkDatabase,
  checkRedis,
  checkElasticsearch,
  checkHealth,
  livenessCheck,
  readinessCheck,
  createHealthRouter,
};
