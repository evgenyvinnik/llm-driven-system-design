import express from 'express';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import dotenv from 'dotenv';

// Load environment variables first
dotenv.config();

// Import database connections
import redis from './db/redis.js';
import pool from './db/pool.js';

// Import shared modules
import logger, { requestLoggerMiddleware } from './shared/logger.js';
import { getMetrics, getMetricsContentType, metricsMiddleware, dbConnectionPoolSize, redisConnectionStatus } from './shared/metrics.js';
import { getAllCircuitBreakerStatus } from './shared/circuitBreaker.js';
import { logRetentionConfig, validateRetentionConfig } from './shared/retention.js';

// Import routes
import authRoutes from './routes/auth.js';
import usersRoutes from './routes/users.js';
import tweetsRoutes from './routes/tweets.js';
import timelineRoutes from './routes/timeline.js';
import trendsRoutes from './routes/trends.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ============================================================================
// Startup Logging
// ============================================================================
logger.info({ port: PORT, nodeEnv: process.env.NODE_ENV }, 'Starting Twitter API server');

// Validate and log retention configuration
validateRetentionConfig();
logRetentionConfig();

// ============================================================================
// Middleware
// ============================================================================

// CORS configuration
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
}));

// JSON body parsing
app.use(express.json());

// Request logging middleware (structured JSON logs)
app.use(requestLoggerMiddleware);

// Prometheus metrics middleware
app.use(metricsMiddleware);

// ============================================================================
// Session Configuration with Redis Store
// ============================================================================
const redisStore = new RedisStore({
  client: redis,
  prefix: 'twitter:session:',
});

app.use(session({
  store: redisStore,
  secret: process.env.SESSION_SECRET || 'twitter-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
  },
}));

// ============================================================================
// Health Check Endpoints
// ============================================================================

/**
 * Basic liveness probe
 * Used by load balancers to check if the process is alive
 */
app.get('/live', (req, res) => {
  res.status(200).send('alive');
});

/**
 * Readiness probe
 * Used by load balancers to check if the service can accept traffic
 * Checks that both PostgreSQL and Redis are accessible
 */
app.get('/ready', async (req, res) => {
  try {
    // Check PostgreSQL
    await pool.query('SELECT 1');

    // Check Redis
    await redis.ping();

    res.status(200).send('ready');
  } catch (error) {
    logger.error({ error: error.message }, 'Readiness check failed');
    res.status(503).send('not ready');
  }
});

/**
 * Comprehensive health check
 * Returns detailed status of all dependencies
 */
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    services: {},
  };

  // Check PostgreSQL
  try {
    const pgStart = Date.now();
    const result = await pool.query('SELECT NOW() as time, current_database() as db');
    const pgLatency = Date.now() - pgStart;

    // Update connection pool metrics
    dbConnectionPoolSize.set({ state: 'total' }, pool.totalCount);
    dbConnectionPoolSize.set({ state: 'idle' }, pool.idleCount);
    dbConnectionPoolSize.set({ state: 'waiting' }, pool.waitingCount);

    health.services.postgres = {
      status: 'ok',
      latencyMs: pgLatency,
      database: result.rows[0].db,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount,
      },
    };
  } catch (error) {
    health.services.postgres = {
      status: 'error',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check Redis
  try {
    const redisStart = Date.now();
    await redis.ping();
    const redisLatency = Date.now() - redisStart;

    // Get Redis info
    const info = await redis.info('server');
    const versionMatch = info.match(/redis_version:(.+)/);

    redisConnectionStatus.set(1);

    health.services.redis = {
      status: 'ok',
      latencyMs: redisLatency,
      version: versionMatch ? versionMatch[1].trim() : 'unknown',
    };
  } catch (error) {
    redisConnectionStatus.set(0);

    health.services.redis = {
      status: 'error',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Include circuit breaker status
  health.circuitBreakers = getAllCircuitBreakerStatus();

  // Total health check duration
  health.checkDurationMs = Date.now() - startTime;

  // Return appropriate status code
  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// ============================================================================
// Prometheus Metrics Endpoint
// ============================================================================

/**
 * Prometheus metrics endpoint
 * Returns metrics in Prometheus text format for scraping
 */
app.get('/metrics', async (req, res) => {
  try {
    // Update connection pool metrics before responding
    dbConnectionPoolSize.set({ state: 'total' }, pool.totalCount);
    dbConnectionPoolSize.set({ state: 'idle' }, pool.idleCount);
    dbConnectionPoolSize.set({ state: 'waiting' }, pool.waitingCount);

    // Update Redis connection status
    try {
      await redis.ping();
      redisConnectionStatus.set(1);
    } catch {
      redisConnectionStatus.set(0);
    }

    const metrics = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to generate metrics');
    res.status(500).send('Error generating metrics');
  }
});

// ============================================================================
// API Routes
// ============================================================================
app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/tweets', tweetsRoutes);
app.use('/api/timeline', timelineRoutes);
app.use('/api/trends', trendsRoutes);

// ============================================================================
// Error Handling Middleware
// ============================================================================
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown';

  logger.error({
    requestId,
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    userId: req.session?.userId,
  }, 'Unhandled error');

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
    requestId,
  });
});

// ============================================================================
// 404 Handler
// ============================================================================
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path,
  });
});

// ============================================================================
// Graceful Shutdown
// ============================================================================
const gracefulShutdown = async (signal) => {
  logger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      // Close database pool
      await pool.end();
      logger.info('Database pool closed');

      // Close Redis connection
      await redis.quit();
      logger.info('Redis connection closed');

      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ error: error.message }, 'Error during shutdown');
      process.exit(1);
    }
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
};

// ============================================================================
// Start Server
// ============================================================================
const server = app.listen(PORT, () => {
  logger.info({ port: PORT }, 'Twitter API server running');
});

// Register shutdown handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
});

export default app;
