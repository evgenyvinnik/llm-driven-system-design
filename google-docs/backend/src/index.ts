/**
 * Main entry point for the Google Docs clone backend server.
 * Configures Express middleware, mounts API routes, and initializes WebSocket server.
 * Supports running multiple instances for load balancing via PORT environment variable.
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import pinoHttp from 'pino-http';

import authRoutes from './routes/auth.js';
import documentsRoutes from './routes/documents.js';
import versionsRoutes from './routes/versions.js';
import commentsRoutes from './routes/comments.js';
import suggestionsRoutes from './routes/suggestions.js';
import { initWebSocket, getCollaborationStats } from './services/collaboration.js';
import logger from './shared/logger.js';
import { register, httpRequestDurationHistogram, httpRequestsCounter } from './shared/metrics.js';
import pool from './utils/db.js';
import redis from './utils/redis.js';

/** Express application instance */
const app = express();

/** Server port, configurable for running multiple instances */
const port = parseInt(process.env.PORT || '3001');

// Structured logging middleware
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/metrics',
  },
  customLogLevel: (req, res, err) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
}));

// Request timing middleware for metrics
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime();

  res.on('finish', () => {
    const [seconds, nanoseconds] = process.hrtime(start);
    const durationSeconds = seconds + nanoseconds / 1e9;

    // Normalize route for metrics (replace UUIDs with :id)
    const route = req.route?.path || req.path.replace(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      ':id'
    );

    httpRequestDurationHistogram.observe(
      { method: req.method, route, status_code: String(res.statusCode) },
      durationSeconds
    );
    httpRequestsCounter.inc(
      { method: req.method, route, status_code: String(res.statusCode) }
    );
  });

  next();
});

// Standard middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

/**
 * Prometheus metrics endpoint.
 * Exposes all registered metrics in Prometheus text format.
 */
app.get('/metrics', async (req: Request, res: Response) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error({ error }, 'Error generating metrics');
    res.status(500).end();
  }
});

/**
 * Enhanced health check endpoint for load balancer monitoring.
 * Returns server identifier and component health status.
 * Performs actual connectivity checks against dependencies.
 */
app.get('/health', async (req: Request, res: Response) => {
  const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};

  // Check PostgreSQL
  const dbStart = Date.now();
  try {
    await pool.query('SELECT 1');
    checks.postgresql = { status: 'healthy', latencyMs: Date.now() - dbStart };
  } catch (error) {
    checks.postgresql = {
      status: 'unhealthy',
      latencyMs: Date.now() - dbStart,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Check Redis
  const redisStart = Date.now();
  try {
    await redis.ping();
    checks.redis = { status: 'healthy', latencyMs: Date.now() - redisStart };
  } catch (error) {
    checks.redis = {
      status: 'unhealthy',
      latencyMs: Date.now() - redisStart,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }

  // Get collaboration stats
  const collabStats = getCollaborationStats();

  const allHealthy = Object.values(checks).every((c) => c.status === 'healthy');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    server: `server-${port}`,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks,
    collaboration: {
      activeDocuments: collabStats.activeDocuments,
      activeConnections: collabStats.activeConnections,
    },
  });
});

/** Mount API route handlers under /api prefix */
app.use('/api/auth', authRoutes);
app.use('/api/documents', documentsRoutes);
app.use('/api/documents', versionsRoutes);
app.use('/api/documents', commentsRoutes);
app.use('/api/documents', suggestionsRoutes);

/**
 * Global error handler for uncaught exceptions in routes.
 * Logs error details and returns generic error response.
 */
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
    user_id: req.user?.id,
  }, 'Unhandled error');

  res.status(500).json({ success: false, error: 'Internal server error' });
});

/** HTTP server instance for Express and WebSocket */
const server = createServer(app);

/** WebSocket server for real-time collaboration, mounted at /ws path */
const wss = new WebSocketServer({ server, path: '/ws' });

/** Initialize WebSocket handlers for document collaboration */
initWebSocket(wss);

/** Start the HTTP server and log connection details */
server.listen(port, () => {
  logger.info({
    port,
    node_env: process.env.NODE_ENV || 'development',
  }, 'Server started');
  logger.info({ url: `http://localhost:${port}` }, 'HTTP server listening');
  logger.info({ url: `ws://localhost:${port}/ws` }, 'WebSocket server listening');
});

/**
 * Graceful shutdown handler for SIGTERM signal.
 * Closes HTTP server and waits for connections to drain before exiting.
 */
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

/**
 * Handle uncaught exceptions.
 */
process.on('uncaughtException', (error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

/**
 * Handle unhandled promise rejections.
 */
process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
