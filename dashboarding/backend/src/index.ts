/**
 * @fileoverview Main entry point for the Dashboarding API server.
 *
 * This module initializes and starts the Express server with all middleware,
 * routes, and background services needed for the metrics monitoring and
 * visualization system. It sets up session management with Redis, security
 * headers, request compression, structured logging, Prometheus metrics,
 * and comprehensive health checks.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import session from 'express-session';
import RedisStore from 'connect-redis';
import pinoHttp from 'pino-http';

import redis from './db/redis.js';
import pool from './db/pool.js';
import logger, { logStartup, logShutdown } from './shared/logger.js';
import { metricsMiddleware, metricsRouter, dbConnectionsActive, dbConnectionsIdle, dbConnectionsTotal } from './shared/metrics.js';
import { healthRouter } from './shared/health.js';
import metricsRoutes from './routes/metrics.js';
import dashboardsRoutes from './routes/dashboards.js';
import alertsRoutes from './routes/alerts.js';
import authRoutes from './routes/auth.js';
import { startAlertEvaluator, stopAlertEvaluator } from './services/alertService.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const ENVIRONMENT = process.env.NODE_ENV || 'development';

// =============================================================================
// Middleware Setup
// =============================================================================

// Security headers
app.use(helmet({ contentSecurityPolicy: false }));

// CORS configuration
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));

// Response compression
app.use(compression());

// JSON body parsing with size limit
app.use(express.json({ limit: '10mb' }));

// Prometheus metrics middleware (before routes to capture all requests)
app.use(metricsMiddleware);

// Structured logging for HTTP requests
app.use(pinoHttp({
  logger,
  // Don't log health check requests to reduce noise
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/health/live',
  },
}));

// Session middleware with Redis store
app.use(session({
  store: new RedisStore({ client: redis }),
  secret: process.env.SESSION_SECRET || 'dashboarding-secret-key-change-in-production',
  resave: false,
  saveUninitialized: false,
  name: 'dashboarding.sid',
  cookie: {
    secure: ENVIRONMENT === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
  },
}));

// =============================================================================
// Database Connection Pool Metrics
// =============================================================================

/**
 * Periodically update database connection pool metrics.
 */
setInterval(() => {
  dbConnectionsTotal.set(pool.totalCount);
  dbConnectionsActive.set(pool.totalCount - pool.idleCount);
  dbConnectionsIdle.set(pool.idleCount);
}, 5000);

// =============================================================================
// Routes
// =============================================================================

// Prometheus metrics endpoint
app.use(metricsRouter);

// Health check endpoints
app.use(healthRouter);

// API routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/metrics', metricsRoutes);
app.use('/api/v1/dashboards', dashboardsRoutes);
app.use('/api/v1/alerts', alertsRoutes);

// =============================================================================
// Error Handling
// =============================================================================

/**
 * Error handling middleware.
 * Logs errors and returns appropriate error responses.
 */
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({
    err,
    method: req.method,
    path: req.path,
    userId: req.session?.userId,
  }, 'Unhandled error');

  // Don't expose internal error details in production
  const message = ENVIRONMENT === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(500).json({ error: 'Internal server error', message });
});

/**
 * 404 handler for unmatched routes.
 */
app.use((req: Request, res: Response) => {
  res.status(404).json({
    error: 'Not found',
    message: `Cannot ${req.method} ${req.path}`,
  });
});

// =============================================================================
// Server Startup
// =============================================================================

const server = app.listen(PORT, () => {
  logStartup(PORT, ENVIRONMENT);

  // Start background services
  startAlertEvaluator(30);
});

// =============================================================================
// Graceful Shutdown
// =============================================================================

/**
 * Handles graceful shutdown on SIGTERM/SIGINT.
 * Closes connections and waits for in-flight requests to complete.
 */
async function gracefulShutdown(signal: string): Promise<void> {
  logShutdown(signal);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Stop background services
  stopAlertEvaluator();

  // Close database connection pool
  try {
    await pool.end();
    logger.info('Database pool closed');
  } catch (error) {
    logger.error({ error }, 'Error closing database pool');
  }

  // Close Redis connection
  try {
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (error) {
    logger.error({ error }, 'Error closing Redis connection');
  }

  // Give time for connections to close
  setTimeout(() => {
    logger.info('Shutdown complete');
    process.exit(0);
  }, 1000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception - shutting down');
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled promise rejection');
});

export default app;
