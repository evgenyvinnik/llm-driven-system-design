import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'path';
import { fileURLToPath } from 'url';

import { connectRedis } from './redis.js';
import { initQueue, getQueueStats, closeQueue } from './shared/queue.js';
import { getMetrics, getMetricsContentType, metricsMiddleware } from './shared/metrics.js';
import { requestLogger, createModuleLogger } from './shared/logger.js';
import { checkCircuitBreakersHealth, getAllCircuitBreakersStatus } from './shared/circuitBreaker.js';
import { updateCacheMetrics } from './shared/cache.js';
import authRoutes from './routes/auth.js';
import listingsRoutes from './routes/listings.js';
import searchRoutes from './routes/search.js';
import bookingsRoutes from './routes/bookings.js';
import reviewsRoutes from './routes/reviews.js';
import messagesRoutes from './routes/messages.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const log = createModuleLogger('server');

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Request logging middleware (structured JSON logs)
app.use(requestLogger);

// Metrics middleware (track HTTP request latency)
app.use(metricsMiddleware);

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Health check endpoint with detailed status
app.get('/health', async (req, res) => {
  const startTime = Date.now();

  try {
    // Check Redis
    let redisStatus = 'healthy';
    try {
      const { default: redisClient } = await import('./redis.js');
      await redisClient.ping();
    } catch {
      redisStatus = 'unhealthy';
    }

    // Check PostgreSQL
    let dbStatus = 'healthy';
    try {
      const { query } = await import('./db.js');
      await query('SELECT 1');
    } catch {
      dbStatus = 'unhealthy';
    }

    // Check RabbitMQ
    let queueStatus = 'healthy';
    let queueStats = {};
    try {
      queueStats = await getQueueStats();
    } catch {
      queueStatus = 'unhealthy';
    }

    // Check circuit breakers
    const circuitBreakerHealth = checkCircuitBreakersHealth();

    const isHealthy = redisStatus === 'healthy' &&
                      dbStatus === 'healthy' &&
                      circuitBreakerHealth.healthy;

    const responseTimeMs = Date.now() - startTime;

    const healthResponse = {
      status: isHealthy ? 'healthy' : 'degraded',
      timestamp: new Date().toISOString(),
      responseTimeMs,
      version: process.env.npm_package_version || '1.0.0',
      uptime: process.uptime(),
      checks: {
        redis: redisStatus,
        database: dbStatus,
        queue: queueStatus,
        circuitBreakers: circuitBreakerHealth,
      },
      queueStats,
    };

    res.status(isHealthy ? 200 : 503).json(healthResponse);
  } catch (error) {
    log.error({ error }, 'Health check failed');
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
});

// Readiness check (for Kubernetes)
app.get('/ready', async (req, res) => {
  try {
    const { query } = await import('./db.js');
    await query('SELECT 1');
    res.status(200).json({ ready: true });
  } catch {
    res.status(503).json({ ready: false });
  }
});

// Liveness check (for Kubernetes)
app.get('/live', (req, res) => {
  res.status(200).json({ alive: true });
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    // Update cache metrics before returning
    await updateCacheMetrics();

    res.set('Content-Type', getMetricsContentType());
    res.end(await getMetrics());
  } catch (error) {
    log.error({ error }, 'Failed to get metrics');
    res.status(500).end(error.message);
  }
});

// Circuit breaker status endpoint (for debugging)
app.get('/debug/circuit-breakers', (req, res) => {
  res.json(getAllCircuitBreakersStatus());
});

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/listings', listingsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/reviews', reviewsRoutes);
app.use('/api/messages', messagesRoutes);

// Error handling middleware
app.use((err, req, res, next) => {
  log.error({
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
    },
    requestId: req.requestId,
    path: req.path,
    method: req.method,
  }, 'Unhandled error');

  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Graceful shutdown
async function shutdown(signal) {
  log.info({ signal }, 'Received shutdown signal');

  // Close RabbitMQ connection
  try {
    await closeQueue();
  } catch (error) {
    log.error({ error }, 'Error closing queue');
  }

  // Close Redis connection
  try {
    const { default: redisClient } = await import('./redis.js');
    await redisClient.quit();
  } catch (error) {
    log.error({ error }, 'Error closing Redis');
  }

  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
async function start() {
  try {
    // Connect to Redis
    await connectRedis();
    log.info('Redis connected');

    // Initialize RabbitMQ (optional - don't fail if unavailable)
    try {
      await initQueue();
      log.info('RabbitMQ connected');
    } catch (error) {
      log.warn({ error: error.message }, 'RabbitMQ not available - async features disabled');
    }

    app.listen(PORT, () => {
      log.info({ port: PORT }, 'Server running');
    });
  } catch (error) {
    log.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();
