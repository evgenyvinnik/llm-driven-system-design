/**
 * Backend Server Entry Point
 *
 * Initializes and starts the Express HTTP server with WebSocket support.
 * Sets up API routes, middleware, health checks, Prometheus metrics,
 * and the WebSocket gateway for real-time communication.
 * Implements graceful shutdown on SIGTERM/SIGINT with proper resource cleanup.
 *
 * @module index
 */

import express from 'express';
import cors from 'cors';
import http from 'http';
import dotenv from 'dotenv';

import streamRoutes from './routes/streams.js';
import userRoutes from './routes/users.js';
import { WebSocketGateway } from './services/wsGateway.js';
import { isHealthy as isDbHealthy, close as closeDb } from './db/index.js';
import { redis, redisSub, redisPub } from './utils/redis.js';
import {
  logger,
  getMetrics,
  getMetricsContentType,
} from './shared/index.js';

dotenv.config();

const serverLogger = logger.child({ module: 'server' });

/** Express application instance */
const app = express();

/** Server port from environment or default to 3001 */
const PORT = parseInt(process.env.PORT || '3001', 10);

/** Flag to track shutdown state */
let isShuttingDown = false;

// Middleware
app.use(cors());
app.use(express.json());

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    serverLogger.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
    }, 'HTTP request');
  });
  next();
});

// ============================================================
// Health Check Endpoints
// ============================================================

/**
 * GET /health
 * Basic liveness check - server is running and can respond.
 * Returns 200 if server is accepting requests.
 */
app.get('/health', (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({
      status: 'shutting_down',
      timestamp: new Date().toISOString(),
    });
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/live
 * Kubernetes-style liveness probe.
 * Returns 200 if the server process is alive.
 */
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

/**
 * GET /health/ready
 * Kubernetes-style readiness probe.
 * Returns 200 only if all dependencies (DB, Redis) are healthy.
 */
app.get('/health/ready', async (_req, res) => {
  if (isShuttingDown) {
    return res.status(503).json({
      status: 'shutting_down',
      checks: {},
    });
  }

  const checks: Record<string, { status: string; latency?: number }> = {};
  let allHealthy = true;

  // Check PostgreSQL
  const dbStart = Date.now();
  try {
    const dbHealthy = await isDbHealthy();
    checks.database = {
      status: dbHealthy ? 'healthy' : 'unhealthy',
      latency: Date.now() - dbStart,
    };
    if (!dbHealthy) allHealthy = false;
  } catch (error) {
    checks.database = { status: 'unhealthy', latency: Date.now() - dbStart };
    allHealthy = false;
  }

  // Check Redis
  const redisStart = Date.now();
  try {
    await redis.ping();
    checks.redis = {
      status: 'healthy',
      latency: Date.now() - redisStart,
    };
  } catch (error) {
    checks.redis = { status: 'unhealthy', latency: Date.now() - redisStart };
    allHealthy = false;
  }

  const status = allHealthy ? 'ready' : 'not_ready';
  res.status(allHealthy ? 200 : 503).json({
    status,
    checks,
    timestamp: new Date().toISOString(),
  });
});

/**
 * GET /health/db
 * Direct database health check with detailed connection pool info.
 */
app.get('/health/db', async (_req, res) => {
  const start = Date.now();
  try {
    const healthy = await isDbHealthy();
    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'healthy' : 'unhealthy',
      latency: Date.now() - start,
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: (error as Error).message,
      latency: Date.now() - start,
    });
  }
});

/**
 * GET /health/redis
 * Direct Redis health check.
 */
app.get('/health/redis', async (_req, res) => {
  const start = Date.now();
  try {
    await redis.ping();
    res.json({
      status: 'healthy',
      latency: Date.now() - start,
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: (error as Error).message,
      latency: Date.now() - start,
    });
  }
});

// ============================================================
// Prometheus Metrics Endpoint
// ============================================================

/**
 * GET /metrics
 * Prometheus-compatible metrics endpoint.
 * Returns all collected metrics in Prometheus text format.
 */
app.get('/metrics', async (_req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    serverLogger.error({ error: (error as Error).message }, 'Failed to collect metrics');
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// ============================================================
// API Routes
// ============================================================

app.use('/api/streams', streamRoutes);
app.use('/api/users', userRoutes);

/** HTTP server instance (used by both Express and WebSocket) */
const server = http.createServer(app);

/** WebSocket gateway for real-time communication */
const wsGateway = new WebSocketGateway(server);

/**
 * GET /api/streams/:streamId/viewers
 * Real-time viewer count endpoint.
 * Provides current viewer count from WebSocket connections.
 */
app.get('/api/streams/:streamId/viewers', (req, res) => {
  const count = wsGateway.getViewerCount(req.params.streamId);
  res.json({ stream_id: req.params.streamId, viewer_count: count });
});

/**
 * GET /api/status
 * Server status endpoint with connection information.
 */
app.get('/api/status', (_req, res) => {
  res.json({
    status: isShuttingDown ? 'shutting_down' : 'running',
    websocket_connections: wsGateway.getTotalConnections(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// Server Start
// ============================================================

server.listen(PORT, () => {
  serverLogger.info({ port: PORT }, 'Server started');
  serverLogger.info({ port: PORT }, 'WebSocket server started');
  serverLogger.info({ port: PORT, path: '/metrics' }, 'Prometheus metrics available');
  serverLogger.info({ port: PORT, path: '/health/ready' }, 'Health checks available');
});

// ============================================================
// Graceful Shutdown
// ============================================================

/**
 * Performs graceful shutdown of all server components.
 *
 * Shutdown sequence:
 * 1. Stop accepting new connections
 * 2. Wait for WebSocket gateway to flush and close connections
 * 3. Close Redis connections
 * 4. Close database connection pool
 * 5. Close HTTP server
 *
 * @param signal - The signal that triggered shutdown (SIGTERM, SIGINT)
 */
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) {
    serverLogger.warn('Shutdown already in progress');
    return;
  }

  isShuttingDown = true;
  serverLogger.info({ signal }, 'Graceful shutdown initiated');

  const shutdownTimeout = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '30000', 10);

  // Create a timeout to force exit if graceful shutdown takes too long
  const forceExitTimeout = setTimeout(() => {
    serverLogger.error('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, shutdownTimeout);

  try {
    // 1. Stop accepting new HTTP connections
    serverLogger.info('Stopping HTTP server from accepting new connections');

    // 2. Gracefully shutdown WebSocket gateway
    serverLogger.info('Shutting down WebSocket gateway');
    await wsGateway.gracefulShutdown(10000);

    // 3. Close Redis connections
    serverLogger.info('Closing Redis connections');
    await Promise.all([
      redis.quit(),
      redisSub.quit(),
      redisPub.quit(),
    ]);

    // 4. Close database connection pool
    serverLogger.info('Closing database connections');
    await closeDb();

    // 5. Close HTTP server
    serverLogger.info('Closing HTTP server');
    await new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    clearTimeout(forceExitTimeout);
    serverLogger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    clearTimeout(forceExitTimeout);
    serverLogger.error({ error: (error as Error).message }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

// Handle shutdown signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions and unhandled rejections
process.on('uncaughtException', (error) => {
  serverLogger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  serverLogger.fatal({ reason, promise }, 'Unhandled rejection');
  // Don't exit for unhandled rejections, just log
});

export { app, server, wsGateway };
