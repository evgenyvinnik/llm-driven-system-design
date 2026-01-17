import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initializeDb, getDb } from './services/database.js';
import { initializeRedis, getRedis } from './services/redis.js';
import { initializeElasticsearch, getElasticsearch } from './services/elasticsearch.js';
import authRoutes from './routes/auth.js';
import productRoutes from './routes/products.js';
import categoryRoutes from './routes/categories.js';
import cartRoutes from './routes/cart.js';
import orderRoutes from './routes/orders.js';
import reviewRoutes from './routes/reviews.js';
import searchRoutes from './routes/search.js';
import adminRoutes from './routes/admin.js';
import { authMiddleware } from './middleware/auth.js';
import { errorHandler } from './middleware/errorHandler.js';
import { startBackgroundJobs } from './services/backgroundJobs.js';

// Import shared modules
import logger, { requestLoggingMiddleware } from './shared/logger.js';
import { metricsHandler, metricsMiddleware, dbConnectionPoolSize } from './shared/metrics.js';
import { idempotencyMiddleware } from './shared/idempotency.js';
import { getAllCircuitBreakerStats } from './shared/circuitBreaker.js';
import { getRetentionStats, runArchivalJobs } from './shared/archival.js';
import { cleanupExpiredIdempotencyKeys } from './shared/idempotency.js';

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// Middleware Setup
// ============================================================

// CORS
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));

// JSON parsing
app.use(express.json());

// Request logging with correlation IDs
app.use(requestLoggingMiddleware);

// Prometheus metrics collection
app.use(metricsMiddleware);

// Idempotency key extraction
app.use(idempotencyMiddleware);

// Auth middleware (attaches user to req if authenticated)
app.use(authMiddleware);

// ============================================================
// Prometheus Metrics Endpoint
// ============================================================
app.get('/metrics', metricsHandler);

// ============================================================
// Health Check Endpoints
// ============================================================

// Simple health check (for load balancers)
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Detailed health check (for monitoring)
app.get('/api/health/detailed', async (req, res) => {
  const healthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    services: {}
  };

  // Check PostgreSQL
  try {
    const db = getDb();
    const start = Date.now();
    await db.query('SELECT 1');
    const latency = Date.now() - start;

    // Update connection pool metrics
    const pool = db;
    if (pool.totalCount !== undefined) {
      dbConnectionPoolSize.set({ state: 'total' }, pool.totalCount);
      dbConnectionPoolSize.set({ state: 'idle' }, pool.idleCount);
      dbConnectionPoolSize.set({ state: 'waiting' }, pool.waitingCount);
    }

    healthStatus.services.postgresql = {
      status: 'ok',
      latencyMs: latency,
      pool: {
        total: pool.totalCount,
        idle: pool.idleCount,
        waiting: pool.waitingCount
      }
    };
  } catch (error) {
    healthStatus.services.postgresql = {
      status: 'error',
      error: error.message
    };
    healthStatus.status = 'degraded';
  }

  // Check Redis
  try {
    const redis = getRedis();
    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;

    healthStatus.services.redis = {
      status: 'ok',
      latencyMs: latency
    };
  } catch (error) {
    healthStatus.services.redis = {
      status: 'error',
      error: error.message
    };
    healthStatus.status = 'degraded';
  }

  // Check Elasticsearch
  try {
    const es = getElasticsearch();
    if (es) {
      const start = Date.now();
      const health = await es.cluster.health();
      const latency = Date.now() - start;

      healthStatus.services.elasticsearch = {
        status: health.status === 'red' ? 'error' : 'ok',
        clusterStatus: health.status,
        latencyMs: latency
      };

      if (health.status === 'red') {
        healthStatus.status = 'degraded';
      }
    } else {
      healthStatus.services.elasticsearch = {
        status: 'unavailable',
        note: 'Elasticsearch client not initialized'
      };
    }
  } catch (error) {
    healthStatus.services.elasticsearch = {
      status: 'error',
      error: error.message
    };
    // Elasticsearch is optional, don't degrade overall status
  }

  // Circuit breaker status
  healthStatus.circuitBreakers = getAllCircuitBreakerStats();

  // Memory usage
  const memUsage = process.memoryUsage();
  healthStatus.memory = {
    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
    rssMB: Math.round(memUsage.rss / 1024 / 1024)
  };

  const statusCode = healthStatus.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(healthStatus);
});

// Liveness probe (Kubernetes)
app.get('/api/health/live', (req, res) => {
  res.json({ status: 'live' });
});

// Readiness probe (Kubernetes)
app.get('/api/health/ready', async (req, res) => {
  try {
    // Check essential services
    const db = getDb();
    await db.query('SELECT 1');

    const redis = getRedis();
    await redis.ping();

    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not_ready', error: error.message });
  }
});

// ============================================================
// Data Retention Stats (Admin)
// ============================================================
app.get('/api/admin/retention-stats', async (req, res) => {
  try {
    const stats = await getRetentionStats();
    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================
// API Routes
// ============================================================
app.use('/api/auth', authRoutes);
app.use('/api/products', productRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/cart', cartRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/admin', adminRoutes);

// ============================================================
// Error Handler
// ============================================================
app.use(errorHandler);

// ============================================================
// Background Jobs
// ============================================================
function startAllBackgroundJobs() {
  // Start existing background jobs
  startBackgroundJobs();

  // Add new archival/cleanup jobs
  // Run idempotency key cleanup every hour
  setInterval(cleanupExpiredIdempotencyKeys, 60 * 60 * 1000);

  // Run archival jobs daily at 3 AM (or every 24 hours from startup)
  setInterval(runArchivalJobs, 24 * 60 * 60 * 1000);

  // Run initial cleanup after startup
  setTimeout(cleanupExpiredIdempotencyKeys, 5000);

  logger.info('All background jobs started');
}

// ============================================================
// Server Startup
// ============================================================
async function start() {
  try {
    logger.info('Starting Amazon API server...');

    logger.info('Initializing database...');
    await initializeDb();

    logger.info('Initializing Redis...');
    await initializeRedis();

    logger.info('Initializing Elasticsearch...');
    await initializeElasticsearch();

    logger.info('Starting background jobs...');
    startAllBackgroundJobs();

    app.listen(PORT, () => {
      logger.info({ port: PORT }, `Amazon API server running on port ${PORT}`);
      console.log(`Amazon API server running on port ${PORT}`);
      console.log(`  - Health check: http://localhost:${PORT}/api/health`);
      console.log(`  - Metrics: http://localhost:${PORT}/metrics`);
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to start server');
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

start();
