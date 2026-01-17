/**
 * Netflix Clone Backend API Server
 *
 * Main entry point for the Express server that provides:
 * - Authentication and session management with RBAC
 * - Video catalog and streaming with circuit breakers
 * - Profile management with personalization
 * - A/B testing infrastructure
 * - Prometheus metrics and structured logging
 * - Rate limiting and health checks
 */
import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';

import { SERVER_CONFIG } from './config.js';
import { logger, httpLogger } from './services/logger.js';
import { metricsMiddleware, getMetrics, getMetricsContentType } from './services/metrics.js';
import { createHealthRouter } from './services/health.js';
import { attachRole } from './middleware/rbac.js';
import { scheduleCleanupJob } from './jobs/watch-history-retention.js';

// Route imports
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profiles.js';
import videoRoutes from './routes/videos.js';
import browseRoutes from './routes/browse.js';
import streamingRoutes from './routes/streaming.js';
import experimentRoutes from './routes/experiments.js';

/**
 * Express application instance.
 * Exported for testing purposes.
 */
const app = express();

// =========================================================
// Global Middleware
// =========================================================

// CORS configuration
app.use(cors({
  origin: SERVER_CONFIG.corsOrigin,
  credentials: true,
}));

// Body parsing
app.use(express.json());

// Cookie parsing
app.use(cookieParser());

// Structured HTTP logging with pino
app.use(httpLogger);

// Prometheus metrics middleware
app.use(metricsMiddleware);

// =========================================================
// Health Check Endpoints
// =========================================================

// Mount health check router
app.use('/health', createHealthRouter());

// =========================================================
// Metrics Endpoint
// =========================================================

/**
 * GET /metrics
 * Prometheus metrics endpoint for scraping.
 * Returns all application and Node.js metrics.
 */
app.get('/metrics', async (_req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error }, 'Failed to get metrics');
    res.status(500).send('Error collecting metrics');
  }
});

// =========================================================
// API Routes
// =========================================================

// Attach role middleware for RBAC (after auth routes set up session)
app.use('/api', attachRole);

// Authentication routes
app.use('/api/auth', authRoutes);

// Profile management
app.use('/api/profiles', profileRoutes);

// Video catalog
app.use('/api/videos', videoRoutes);

// Personalized browsing
app.use('/api/browse', browseRoutes);

// Video streaming
app.use('/api/stream', streamingRoutes);

// A/B testing
app.use('/api/experiments', experimentRoutes);

// =========================================================
// Error Handling
// =========================================================

/**
 * Global error handler.
 * Logs errors and returns appropriate HTTP responses.
 */
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    accountId: req.accountId,
  }, 'Unhandled error');

  // Don't expose internal errors in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(500).json({ error: message });
});

/**
 * 404 handler for unknown routes.
 */
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// =========================================================
// Server Startup
// =========================================================

const PORT = SERVER_CONFIG.port;

// Start background jobs
let stopCleanupJob: (() => void) | null = null;

if (process.env.NODE_ENV !== 'test') {
  // Schedule watch history cleanup job (runs every 24 hours)
  stopCleanupJob = scheduleCleanupJob(24 * 60 * 60 * 1000);
}

const server = app.listen(PORT, () => {
  logger.info({
    port: PORT,
    environment: process.env.NODE_ENV || 'development',
    corsOrigin: SERVER_CONFIG.corsOrigin,
  }, 'Netflix API server started');

  console.log(`Netflix API server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Metrics: http://localhost:${PORT}/metrics`);
});

// =========================================================
// Graceful Shutdown
// =========================================================

/**
 * Handles graceful shutdown on SIGTERM/SIGINT.
 * Closes server and cleans up resources.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Received shutdown signal');

  // Stop accepting new connections
  server.close((err) => {
    if (err) {
      logger.error({ error: err }, 'Error closing server');
      process.exit(1);
    }

    logger.info('Server closed');
  });

  // Stop background jobs
  if (stopCleanupJob) {
    stopCleanupJob();
  }

  // Give in-flight requests time to complete
  setTimeout(() => {
    logger.info('Shutdown complete');
    process.exit(0);
  }, 10000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export default app;
