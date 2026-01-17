import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import config from './config/index.js';

// Shared modules
import logger, { requestLogger } from './shared/logger.js';
import { metricsMiddleware, metricsHandler, transcodeQueueDepth } from './shared/metrics.js';
import { rateLimit } from './shared/rateLimiter.js';
import { livenessHandler, readinessHandler, detailedHealthHandler } from './shared/health.js';

// Routes
import authRoutes from './routes/auth.js';
import uploadRoutes from './routes/upload.js';
import videoRoutes from './routes/videos.js';
import channelRoutes from './routes/channels.js';
import feedRoutes from './routes/feed.js';

// Utils
import { flushViewCounts } from './utils/redis.js';
import { query } from './utils/db.js';
import { getQueueLength } from './services/transcoding.js';

const app = express();

// ============ Core Middleware ============

// CORS
app.use(cors(config.cors));

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Cookie parsing
app.use(cookieParser());

// ============ Observability Middleware ============

// Structured request logging with request ID
app.use(requestLogger);

// Prometheus metrics collection
app.use(metricsMiddleware);

// ============ Health and Metrics Endpoints ============

// Liveness probe (quick check - is the service running?)
app.get('/health', livenessHandler);

// Readiness probe (deep check - are all dependencies healthy?)
app.get('/health/ready', readinessHandler);

// Detailed health for monitoring dashboards
app.get('/health/detailed', detailedHealthHandler);

// Prometheus metrics endpoint
app.get('/metrics', metricsHandler);

// ============ Rate-Limited API Routes ============

// Apply global rate limiting to all API routes
app.use('/api/v1', rateLimit());

// API Routes with appropriate rate limiting
app.use('/api/v1/auth', rateLimit('auth'), authRoutes);
app.use('/api/v1/uploads', rateLimit('upload'), uploadRoutes);
app.use('/api/v1/videos', videoRoutes);
app.use('/api/v1/channels', channelRoutes);
app.use('/api/v1/feed', feedRoutes);

// ============ Error Handling ============

// Global error handler with structured logging
app.use((err, req, res, next) => {
  const log = req.log || logger;

  // Determine error severity
  const isOperationalError = err.statusCode && err.statusCode < 500;

  if (isOperationalError) {
    log.warn({
      event: 'operational_error',
      error: err.message,
      statusCode: err.statusCode,
      stack: err.stack,
    }, 'Operational error occurred');
  } else {
    log.error({
      event: 'unhandled_error',
      error: err.message,
      statusCode: err.statusCode || 500,
      stack: err.stack,
    }, 'Unhandled error occurred');
  }

  // Don't leak internal errors in production
  const message =
    process.env.NODE_ENV === 'production' && !isOperationalError
      ? 'Internal server error'
      : err.message;

  res.status(err.statusCode || 500).json({
    error: message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  });
});

// 404 handler
app.use((req, res) => {
  (req.log || logger).warn({
    event: 'route_not_found',
    path: req.path,
    method: req.method,
  }, `Route not found: ${req.method} ${req.path}`);

  res.status(404).json({ error: 'Not found' });
});

// ============ Background Jobs ============

/**
 * Background job: Flush view counts to database
 * Runs every minute to persist buffered view counts from Redis
 */
const startViewCountFlusher = () => {
  setInterval(async () => {
    try {
      const counts = await flushViewCounts();
      const videoIds = Object.keys(counts);

      if (videoIds.length > 0) {
        for (const [videoId, count] of Object.entries(counts)) {
          await query(
            'UPDATE videos SET view_count = view_count + $1 WHERE id = $2',
            [count, videoId]
          );
        }
        logger.info({
          event: 'view_counts_flushed',
          videoCount: videoIds.length,
          totalViews: Object.values(counts).reduce((a, b) => a + b, 0),
        }, `Flushed view counts for ${videoIds.length} videos`);
      }
    } catch (error) {
      logger.error({ error: error.message }, 'Failed to flush view counts');
    }
  }, 60000); // Every minute
};

/**
 * Background job: Update transcoding queue metrics
 * Runs every 10 seconds to report queue depth
 */
const startQueueMetricsUpdater = () => {
  setInterval(() => {
    const queueLength = getQueueLength();
    transcodeQueueDepth.set(queueLength);

    if (queueLength > 10) {
      logger.warn({
        event: 'transcode_queue_high',
        depth: queueLength,
      }, `Transcoding queue depth is high: ${queueLength}`);
    }
  }, 10000); // Every 10 seconds
};

// ============ Graceful Shutdown ============

const gracefulShutdown = async (signal) => {
  logger.info({ signal }, `Received ${signal}, starting graceful shutdown`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  try {
    // Flush any remaining view counts
    const counts = await flushViewCounts();
    if (Object.keys(counts).length > 0) {
      for (const [videoId, count] of Object.entries(counts)) {
        await query(
          'UPDATE videos SET view_count = view_count + $1 WHERE id = $2',
          [count, videoId]
        );
      }
      logger.info({ videoCount: Object.keys(counts).length }, 'Flushed remaining view counts');
    }
  } catch (error) {
    logger.error({ error: error.message }, 'Error during shutdown');
  }

  logger.info('Graceful shutdown complete');
  process.exit(0);
};

let server;

// ============ Server Startup ============

const start = async () => {
  try {
    // Test database connection
    await query('SELECT 1');
    logger.info({ host: config.postgres.host, port: config.postgres.port }, 'Database connected');

    // Start background jobs
    startViewCountFlusher();
    startQueueMetricsUpdater();

    // Start HTTP server
    server = app.listen(config.port, () => {
      logger.info({
        port: config.port,
        nodeVersion: process.version,
        env: process.env.NODE_ENV || 'development',
      }, `Server running on port ${config.port}`);

      logger.info(`API available at http://localhost:${config.port}/api/v1`);
      logger.info(`Metrics available at http://localhost:${config.port}/metrics`);
      logger.info(`Health check at http://localhost:${config.port}/health/ready`);
    });

    // Handle graceful shutdown
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to start server');
    process.exit(1);
  }
};

start();

export default app;
