import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { Pool } from 'pg';
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
import { getAllCircuitBreakerStats, CircuitBreakerStats } from './shared/circuitBreaker.js';
import { getRetentionStats, RetentionStats } from './shared/archival.js';
import { cleanupExpiredIdempotencyKeys } from './shared/idempotency.js';

// Type definitions
interface ServiceStatus {
  status: 'ok' | 'error' | 'unavailable';
  latencyMs?: number;
  error?: string;
  pool?: {
    total: number | undefined;
    idle: number | undefined;
    waiting: number | undefined;
  };
  clusterStatus?: string;
  note?: string;
}

interface HealthStatus {
  status: 'ok' | 'degraded';
  timestamp: string;
  uptime: number;
  version: string;
  services: {
    postgresql?: ServiceStatus;
    redis?: ServiceStatus;
    elasticsearch?: ServiceStatus;
  };
  circuitBreakers?: CircuitBreakerStats[];
  memory?: {
    heapUsedMB: number;
    heapTotalMB: number;
    rssMB: number;
  };
}

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
app.get('/api/health', (_req: Request, res: Response): void => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Detailed health check (for monitoring)
app.get('/api/health/detailed', async (_req: Request, res: Response): Promise<void> => {
  const healthStatus: HealthStatus = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    services: {}
  };

  // Check PostgreSQL
  try {
    const db: Pool = getDb();
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
    const err = error as Error;
    healthStatus.services.postgresql = {
      status: 'error',
      error: err.message
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
    const err = error as Error;
    healthStatus.services.redis = {
      status: 'error',
      error: err.message
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
    const err = error as Error;
    healthStatus.services.elasticsearch = {
      status: 'error',
      error: err.message
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
app.get('/api/health/live', (_req: Request, res: Response): void => {
  res.json({ status: 'live' });
});

// Readiness probe (Kubernetes)
app.get('/api/health/ready', async (_req: Request, res: Response): Promise<void> => {
  try {
    // Check essential services
    const db: Pool = getDb();
    await db.query('SELECT 1');

    const redis = getRedis();
    await redis.ping();

    res.json({ status: 'ready' });
  } catch (error) {
    const err = error as Error;
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
});

// ============================================================
// Data Retention Stats (Admin)
// ============================================================
app.get('/api/admin/retention-stats', async (_req: Request, res: Response): Promise<void> => {
  try {
    const stats: RetentionStats = await getRetentionStats();
    res.json(stats);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
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
function startAllBackgroundJobs(): void {
  // Start existing background jobs
  startBackgroundJobs();

  // Add new archival/cleanup jobs
  // Run idempotency key cleanup every hour
  setInterval(cleanupExpiredIdempotencyKeys, 60 * 60 * 1000);

  // Run archival jobs daily at 3 AM (or every 24 hours from startup)
  setInterval(() => {
    void import('./shared/archival.js').then(({ runArchivalJobs }) => runArchivalJobs());
  }, 24 * 60 * 60 * 1000);

  // Run initial cleanup after startup
  setTimeout(() => {
    void cleanupExpiredIdempotencyKeys();
  }, 5000);

  logger.info('All background jobs started');
}

// ============================================================
// Server Startup
// ============================================================
async function start(): Promise<void> {
  try {
    logger.info('Starting Amazon API server...');

    // Retry rather than exiting on the first failure: the containers accept
    // connections while still initializing, so a backend started next to them
    // can lose the race — and exiting meant the port never bound, which shows
    // up only as a Vite proxy error on the login request.
    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        logger.info('Initializing database...');
        await initializeDb();

        logger.info('Initializing Redis...');
        await initializeRedis();
        break;
      } catch (error) {
        if (attempt === 10) throw error;
        const err = error as Error;
        logger.warn({ error: err.message, attempt }, 'Dependencies not ready, retrying in 2s...');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }

    // Elasticsearch powers search, which falls back to Postgres full-text — so a
    // slow or absent ES must degrade search, not prevent the server from starting.
    logger.info('Initializing Elasticsearch...');
    try {
      await initializeElasticsearch();
    } catch (error) {
      const err = error as Error;
      logger.warn({ error: err.message }, 'Elasticsearch unavailable; search will use the PostgreSQL fallback');
    }

    logger.info('Starting background jobs...');
    startAllBackgroundJobs();

    app.listen(PORT, () => {
      logger.info({ port: PORT }, `Amazon API server running on port ${PORT}`);
      console.log(`Amazon API server running on port ${PORT}`);
      console.log(`  - Health check: http://localhost:${PORT}/api/health`);
      console.log(`  - Metrics: http://localhost:${PORT}/metrics`);
    });
  } catch (error) {
    const err = error as Error;
    logger.error({ error: err.message }, 'Failed to start server');
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', (): void => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', (): void => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

start();
