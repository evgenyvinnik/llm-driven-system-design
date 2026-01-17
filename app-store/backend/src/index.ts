/**
 * @fileoverview Main entry point for the App Store backend server.
 * Initializes Express with security middleware, API routes, and external services.
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import routes from './routes/index.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { initializeElasticsearch } from './config/elasticsearch.js';
import { ensureBuckets } from './config/minio.js';

// Import shared modules
import { logger, logging } from './shared/logger.js';
import {
  metricsMiddleware,
  getMetrics,
  getMetricsContentType,
} from './shared/metrics.js';
import { connectRabbitMQ, closeRabbitMQ } from './shared/queue.js';
import { healthCheck, livenessProbe, readinessProbe } from './shared/health.js';

/** Express application instance configured with middleware stack */
const app = express();

// =============================================================================
// Middleware Stack
// =============================================================================

// Security middleware
app.use(helmet());
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));

// Metrics middleware (before routes)
app.use(metricsMiddleware());

// Request logging middleware using pino
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logging.request(req.method, req.originalUrl, res.statusCode, duration, {
      userAgent: req.headers['user-agent'],
      ip: req.ip,
      userId: (req as any).user?.id,
    });
  });

  next();
});

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// =============================================================================
// Health Check Endpoints (before API routes)
// =============================================================================

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to get metrics');
    res.status(500).send('Error collecting metrics');
  }
});

// Health check endpoints
app.get('/health', healthCheck);
app.get('/health/live', livenessProbe);
app.get('/health/ready', readinessProbe);

// =============================================================================
// API Routes
// =============================================================================

app.use(`/api/${config.api.version}`, routes);

// =============================================================================
// Error Handling
// =============================================================================

app.use(notFound);
app.use(errorHandler);

// =============================================================================
// Server Initialization
// =============================================================================

/**
 * Initializes external services and starts the HTTP server.
 * Connects to Elasticsearch, MinIO, and RabbitMQ before accepting requests.
 * @returns Promise that resolves when server is running or rejects on failure
 */
async function start() {
  try {
    logger.info('Starting App Store backend...');

    // Initialize services in parallel where possible
    logger.info('Initializing Elasticsearch...');
    await initializeElasticsearch();
    logger.info('Elasticsearch initialized');

    logger.info('Initializing MinIO buckets...');
    await ensureBuckets();
    logger.info('MinIO buckets initialized');

    // RabbitMQ connection (non-blocking - will retry in background)
    logger.info('Connecting to RabbitMQ...');
    try {
      await connectRabbitMQ();
      logger.info('RabbitMQ connected');
    } catch (error) {
      logger.warn({ error: (error as Error).message }, 'RabbitMQ initial connection failed, will retry in background');
    }

    // Start HTTP server
    const server = app.listen(config.port, () => {
      logger.info({
        port: config.port,
        env: config.nodeEnv,
        apiVersion: config.api.version,
      }, `Server running on http://localhost:${config.port}`);
      logger.info(`API available at http://localhost:${config.port}/api/${config.api.version}`);
      logger.info(`Metrics available at http://localhost:${config.port}/metrics`);
      logger.info(`Health check at http://localhost:${config.port}/health`);
    });

    // Graceful shutdown handling
    const shutdown = async (signal: string) => {
      logger.info({ signal }, 'Received shutdown signal');

      // Stop accepting new connections
      server.close(() => {
        logger.info('HTTP server closed');
      });

      // Close external connections
      try {
        await closeRabbitMQ();
        logger.info('RabbitMQ connection closed');
      } catch (error) {
        logger.error({ error: (error as Error).message }, 'Error closing RabbitMQ connection');
      }

      // Give time for in-flight requests to complete
      setTimeout(() => {
        logger.info('Shutdown complete');
        process.exit(0);
      }, 5000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export default app;
