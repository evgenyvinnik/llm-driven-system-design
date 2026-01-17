/**
 * Health Check Endpoints
 *
 * Provides comprehensive health checking for:
 * - Liveness: Is the process running?
 * - Readiness: Is the service ready to accept traffic?
 * - Detailed health: Status of all dependencies
 *
 * Used by:
 * - Load balancers for routing decisions
 * - Kubernetes for pod lifecycle management
 * - Monitoring systems for alerting
 */
const { logger } = require('./logger');
const { getCircuitBreakerStats } = require('./circuitBreaker');

/**
 * Check PostgreSQL connectivity
 * @param {Object} pool - PostgreSQL connection pool
 * @returns {Promise<{status: string, latency_ms: number|null, error?: string}>}
 */
async function checkPostgres(pool) {
  const start = Date.now();
  try {
    await pool.query('SELECT 1');
    return {
      status: 'healthy',
      latency_ms: Date.now() - start
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency_ms: null,
      error: error.message
    };
  }
}

/**
 * Check Redis connectivity
 * @param {Object} redis - Redis client
 * @returns {Promise<{status: string, latency_ms: number|null, error?: string}>}
 */
async function checkRedis(redis) {
  const start = Date.now();
  try {
    await redis.ping();
    return {
      status: 'healthy',
      latency_ms: Date.now() - start
    };
  } catch (error) {
    return {
      status: 'unhealthy',
      latency_ms: null,
      error: error.message
    };
  }
}

/**
 * Create health check endpoints
 * @param {Object} deps - Dependencies to check
 * @param {Object} deps.pool - PostgreSQL connection pool
 * @param {Object} deps.redis - Redis client
 * @returns {Object} Express router handlers
 */
function createHealthChecks(deps) {
  const { pool, redis } = deps;

  return {
    /**
     * Liveness probe - just checks if process is running
     * Returns 200 if process is alive
     */
    liveness: (req, res) => {
      res.json({
        status: 'alive',
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor(process.uptime())
      });
    },

    /**
     * Readiness probe - checks if service can accept traffic
     * Returns 200 if ready, 503 if not
     */
    readiness: async (req, res) => {
      try {
        // Check critical dependencies
        const [pgCheck, redisCheck] = await Promise.all([
          checkPostgres(pool),
          checkRedis(redis)
        ]);

        const isReady = pgCheck.status === 'healthy' && redisCheck.status === 'healthy';

        if (isReady) {
          res.json({
            status: 'ready',
            timestamp: new Date().toISOString()
          });
        } else {
          res.status(503).json({
            status: 'not ready',
            checks: {
              postgres: pgCheck,
              redis: redisCheck
            },
            timestamp: new Date().toISOString()
          });
        }
      } catch (error) {
        logger.error({ error: error.message }, 'readiness check failed');
        res.status(503).json({
          status: 'not ready',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    },

    /**
     * Detailed health check - comprehensive status of all components
     * Returns 200 if all healthy, 503 if any unhealthy
     */
    health: async (req, res) => {
      try {
        const checks = {};

        // Check PostgreSQL
        checks.postgres = await checkPostgres(pool);

        // Check Redis
        checks.redis = await checkRedis(redis);

        // Get circuit breaker status
        checks.circuit_breakers = getCircuitBreakerStats();

        // Memory usage
        const memUsage = process.memoryUsage();
        checks.memory = {
          status: 'healthy',
          heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
          heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
          rss_mb: Math.round(memUsage.rss / 1024 / 1024)
        };

        // Event loop lag (simple check)
        const startLag = Date.now();
        await new Promise(resolve => setImmediate(resolve));
        const eventLoopLag = Date.now() - startLag;
        checks.event_loop = {
          status: eventLoopLag < 100 ? 'healthy' : 'degraded',
          lag_ms: eventLoopLag
        };

        // Determine overall status
        const allHealthy =
          checks.postgres.status === 'healthy' &&
          checks.redis.status === 'healthy' &&
          checks.memory.status === 'healthy';

        const statusCode = allHealthy ? 200 : 503;
        const overallStatus = allHealthy ? 'healthy' : 'degraded';

        res.status(statusCode).json({
          status: overallStatus,
          version: process.env.npm_package_version || '1.0.0',
          instance: process.env.INSTANCE_ID || `port-${process.env.PORT || 3001}`,
          uptime_seconds: Math.floor(process.uptime()),
          checks,
          timestamp: new Date().toISOString()
        });
      } catch (error) {
        logger.error({ error: error.message }, 'health check failed');
        res.status(503).json({
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString()
        });
      }
    }
  };
}

/**
 * Simple health check for backward compatibility
 */
function simpleHealthCheck(req, res) {
  res.json({
    status: 'ok',
    port: process.env.PORT || 3001,
    timestamp: new Date().toISOString()
  });
}

module.exports = {
  createHealthChecks,
  checkPostgres,
  checkRedis,
  simpleHealthCheck
};
