import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { initializeDatabase, getPool } from './models/database.js';
import { initializeRedis, getRedisClient } from './services/redis.js';
import { TrendingService } from './services/trendingService.js';
import videoRoutes from './routes/videos.js';
import trendingRoutes from './routes/trending.js';
import sseRoutes from './routes/sse.js';

// Import shared modules
import { SERVER_CONFIG, ALERT_THRESHOLDS, RETENTION_CONFIG } from './shared/config.js';
import logger, { requestLogger, logError } from './shared/logger.js';
import {
  getMetrics,
  getContentType,
  metricsMiddleware,
  sseClientsConnected,
  redisMemoryUsage,
  tableRowCount,
  pgActiveConnections,
  checkThreshold,
  updateAlertStatus,
} from './shared/metrics.js';

const app = express();
const PORT = SERVER_CONFIG.port;

// Middleware
app.use(cors());
app.use(express.json());

// Prometheus metrics middleware (must be early to capture all requests)
app.use(metricsMiddleware);

// Structured request logging
app.use(requestLogger);

// ============================================
// Health Check Endpoints
// ============================================

/**
 * GET /health
 * Simple health check for load balancer probes
 */
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

/**
 * GET /health/ready
 * Readiness probe - checks if all dependencies are available
 */
app.get('/health/ready', async (req, res) => {
  const checks = {
    postgres: 'unknown',
    redis: 'unknown',
    trendingService: 'unknown',
  };

  try {
    // Check PostgreSQL
    const pool = getPool();
    await pool.query('SELECT 1');
    checks.postgres = 'healthy';
  } catch (err) {
    checks.postgres = 'unhealthy';
    logError(err, { check: 'postgres' });
  }

  try {
    // Check Redis
    const redis = await getRedisClient();
    await redis.ping();
    checks.redis = 'healthy';
  } catch (err) {
    checks.redis = 'unhealthy';
    logError(err, { check: 'redis' });
  }

  try {
    // Check TrendingService
    const trendingService = TrendingService.getInstance();
    if (trendingService && trendingService.intervalId) {
      checks.trendingService = 'healthy';
    } else {
      checks.trendingService = 'not_started';
    }
  } catch (err) {
    checks.trendingService = 'unhealthy';
    logError(err, { check: 'trendingService' });
  }

  const isReady = Object.values(checks).every((c) => c === 'healthy' || c === 'not_started');

  res.status(isReady ? 200 : 503).json({
    status: isReady ? 'ready' : 'not_ready',
    timestamp: new Date().toISOString(),
    checks,
  });
});

/**
 * GET /health/live
 * Liveness probe - checks if the process is running
 */
app.get('/health/live', (req, res) => {
  res.json({
    status: 'alive',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    pid: process.pid,
    memory: process.memoryUsage(),
  });
});

/**
 * GET /health/detailed
 * Detailed health check with metrics and thresholds
 */
app.get('/health/detailed', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {},
    alerts: [],
  };

  try {
    // PostgreSQL checks
    const pool = getPool();
    const pgResult = await pool.query(`
      SELECT
        (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) as connections,
        (SELECT count(*) FROM view_events) as view_events_count,
        (SELECT count(*) FROM trending_snapshots) as snapshots_count
    `);

    const pgStats = pgResult.rows[0];
    health.checks.postgres = {
      status: 'healthy',
      connections: parseInt(pgStats.connections),
      viewEventsCount: parseInt(pgStats.view_events_count),
      snapshotsCount: parseInt(pgStats.snapshots_count),
    };

    // Update metrics
    pgActiveConnections.set(health.checks.postgres.connections);
    tableRowCount.set({ table: 'view_events' }, health.checks.postgres.viewEventsCount);
    tableRowCount.set({ table: 'trending_snapshots' }, health.checks.postgres.snapshotsCount);

    // Check thresholds
    const viewEventsCheck = checkThreshold('view_events_rows', health.checks.postgres.viewEventsCount);
    const snapshotsCheck = checkThreshold('snapshots_rows', health.checks.postgres.snapshotsCount);

    if (viewEventsCheck.status !== 'ok') {
      health.alerts.push({
        metric: 'view_events_rows',
        ...viewEventsCheck,
      });
    }
    if (snapshotsCheck.status !== 'ok') {
      health.alerts.push({
        metric: 'snapshots_rows',
        ...snapshotsCheck,
      });
    }
  } catch (err) {
    health.checks.postgres = { status: 'unhealthy', error: err.message };
    health.status = 'unhealthy';
    logError(err, { check: 'postgres_detailed' });
  }

  try {
    // Redis checks
    const redis = await getRedisClient();
    const info = await redis.info('memory');
    const memoryMatch = info.match(/used_memory:(\d+)/);
    const memoryBytes = memoryMatch ? parseInt(memoryMatch[1]) : 0;

    const bucketKeys = await redis.keys('views:bucket:*');

    health.checks.redis = {
      status: 'healthy',
      memoryBytes,
      memoryHuman: `${(memoryBytes / 1024 / 1024).toFixed(2)}MB`,
      bucketKeyCount: bucketKeys.length,
    };

    // Update metrics
    redisMemoryUsage.set(memoryBytes);

    // Check threshold
    const memoryCheck = checkThreshold('redis_memory', memoryBytes);
    if (memoryCheck.status !== 'ok') {
      health.alerts.push({
        metric: 'redis_memory',
        ...memoryCheck,
      });
    }
    updateAlertStatus('redis_memory', memoryBytes, ALERT_THRESHOLDS.redisMemoryWarningBytes, ALERT_THRESHOLDS.redisMemoryCriticalBytes);
  } catch (err) {
    health.checks.redis = { status: 'unhealthy', error: err.message };
    health.status = 'unhealthy';
    logError(err, { check: 'redis_detailed' });
  }

  try {
    // TrendingService checks
    const trendingService = TrendingService.getInstance();
    const stats = await trendingService.getStats();

    health.checks.trendingService = {
      status: 'healthy',
      ...stats,
    };

    // Update SSE client metric
    sseClientsConnected.set(stats.connectedClients);

    // Check SSE clients threshold
    const sseCheck = checkThreshold('sse_clients', stats.connectedClients);
    if (sseCheck.status !== 'ok') {
      health.alerts.push({
        metric: 'sse_clients',
        ...sseCheck,
      });
    }
  } catch (err) {
    health.checks.trendingService = { status: 'unhealthy', error: err.message };
    health.status = 'unhealthy';
    logError(err, { check: 'trending_service_detailed' });
  }

  // Overall status based on alerts
  if (health.alerts.some((a) => a.status === 'critical')) {
    health.status = 'critical';
  } else if (health.alerts.some((a) => a.status === 'warning')) {
    health.status = 'warning';
  }

  const statusCode = health.status === 'healthy' ? 200 : health.status === 'warning' ? 200 : 503;
  res.status(statusCode).json(health);
});

// ============================================
// Metrics Endpoint
// ============================================

/**
 * GET /metrics
 * Prometheus metrics endpoint
 */
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getContentType());
    res.end(metrics);
  } catch (err) {
    logError(err, { endpoint: '/metrics' });
    res.status(500).end('Error collecting metrics');
  }
});

// ============================================
// API Routes
// ============================================

app.use('/api/videos', videoRoutes);
app.use('/api/trending', trendingRoutes);
app.use('/api/sse', sseRoutes);

// ============================================
// Error Handling
// ============================================

// 404 handler
app.use((req, res, next) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Error handling middleware
app.use((err, req, res, next) => {
  logError(err, {
    method: req.method,
    path: req.path,
    requestId: req.requestId,
  });

  res.status(500).json({
    error: 'Internal server error',
    message: SERVER_CONFIG.nodeEnv === 'development' ? err.message : 'An unexpected error occurred',
    requestId: req.requestId,
  });
});

// ============================================
// Server Startup
// ============================================

async function start() {
  try {
    logger.info('Initializing database...');
    await initializeDatabase();

    logger.info('Initializing Redis...');
    await initializeRedis();

    logger.info('Starting trending service...');
    const trendingService = TrendingService.getInstance();
    await trendingService.start();

    app.listen(PORT, () => {
      logger.info(
        {
          port: PORT,
          env: SERVER_CONFIG.nodeEnv,
          pid: process.pid,
        },
        `Server running on port ${PORT}`
      );
      logger.info({ url: `http://localhost:${PORT}/health` }, 'Health check endpoint');
      logger.info({ url: `http://localhost:${PORT}/metrics` }, 'Prometheus metrics endpoint');
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully...');

  const trendingService = TrendingService.getInstance();
  trendingService.stop();

  const pool = getPool();
  await pool.end();

  const redis = await getRedisClient();
  await redis.quit();

  logger.info('Shutdown complete');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully...');
  process.emit('SIGTERM');
});

start();
