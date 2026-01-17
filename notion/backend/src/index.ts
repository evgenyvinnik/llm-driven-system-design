/**
 * @fileoverview Main entry point for the Notion-like backend server.
 * Sets up Express with CORS, cookie parsing, structured logging, metrics,
 * and REST API routes. Attaches WebSocket server for real-time collaboration.
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';

import authRoutes from './routes/auth.js';
import workspacesRoutes from './routes/workspaces.js';
import pagesRoutes from './routes/pages.js';
import blocksRoutes from './routes/blocks.js';
import databasesRoutes from './routes/databases.js';
import { setupWebSocket } from './services/websocket.js';

// Import shared modules
import { logger, requestLogger } from './shared/logger.js';
import { metricsMiddleware, metricsHandler, dbPoolGauge } from './shared/metrics.js';
import { queueManager } from './shared/queue.js';
import pool from './models/db.js';
import redis from './models/redis.js';

const app = express();
const PORT = process.env.PORT || 3001;
const SERVER_ID = process.env.SERVER_ID || `server-${PORT}`;

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Add structured logging middleware
app.use(requestLogger);

// Add Prometheus metrics middleware
app.use(metricsMiddleware);

/**
 * GET /health
 * Comprehensive health check endpoint that verifies all service dependencies.
 * Returns status of database, Redis, and RabbitMQ connections.
 */
app.get('/health', async (_, res) => {
  const health: {
    status: 'ok' | 'degraded' | 'unhealthy';
    timestamp: string;
    version: string;
    serverId: string;
    checks: Record<string, { status: 'ok' | 'error'; latency?: number; error?: string }>;
  } = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.APP_VERSION || '1.0.0',
    serverId: SERVER_ID,
    checks: {},
  };

  // Check PostgreSQL
  const dbStart = Date.now();
  try {
    await pool.query('SELECT 1');
    health.checks.database = { status: 'ok', latency: Date.now() - dbStart };

    // Update pool metrics
    const poolStatus = pool as unknown as { totalCount: number; idleCount: number; waitingCount: number };
    if (poolStatus.totalCount !== undefined) {
      dbPoolGauge.set({ state: 'active' }, poolStatus.totalCount - poolStatus.idleCount);
      dbPoolGauge.set({ state: 'idle' }, poolStatus.idleCount);
      dbPoolGauge.set({ state: 'waiting' }, poolStatus.waitingCount);
    }
  } catch (error) {
    health.checks.database = { status: 'error', error: (error as Error).message };
    health.status = 'degraded';
  }

  // Check Redis
  const redisStart = Date.now();
  try {
    await redis.ping();
    health.checks.redis = { status: 'ok', latency: Date.now() - redisStart };
  } catch (error) {
    health.checks.redis = { status: 'error', error: (error as Error).message };
    health.status = 'degraded';
  }

  // Check RabbitMQ
  try {
    const isConnected = queueManager.isConnected();
    health.checks.rabbitmq = { status: isConnected ? 'ok' : 'error' };
    if (!isConnected) {
      health.checks.rabbitmq.error = 'Not connected';
      // RabbitMQ is optional - don't mark as degraded if not connected
    }
  } catch (error) {
    health.checks.rabbitmq = { status: 'error', error: (error as Error).message };
  }

  // Set overall status
  if (health.checks.database.status === 'error') {
    health.status = 'unhealthy';
  }

  const statusCode = health.status === 'ok' ? 200 : health.status === 'degraded' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * GET /ready
 * Readiness probe for Kubernetes/load balancers.
 * Returns 200 only when the service is ready to accept traffic.
 */
app.get('/ready', async (_, res) => {
  try {
    // Verify database is accessible
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not ready' });
  }
});

/**
 * GET /metrics
 * Prometheus metrics endpoint for scraping.
 * Returns all application and Node.js runtime metrics.
 */
app.get('/metrics', metricsHandler);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspacesRoutes);
app.use('/api/pages', pagesRoutes);
app.use('/api/blocks', blocksRoutes);
app.use('/api/databases', databasesRoutes);

// Error handling middleware with structured logging
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // Use request logger if available, otherwise use base logger
  const log = req.log || logger;
  log.error({ error: err, stack: err.stack }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = createServer(app);

// Setup WebSocket
setupWebSocket(server);

// Graceful shutdown handler
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received, closing connections...');

  // Stop accepting new connections
  server.close(async () => {
    logger.info('HTTP server closed');

    // Close RabbitMQ connection
    try {
      await queueManager.close();
      logger.info('RabbitMQ connection closed');
    } catch (error) {
      logger.error({ error }, 'Error closing RabbitMQ connection');
    }

    // Close database pool
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

    logger.info('Graceful shutdown complete');
    process.exit(0);
  });

  // Force exit after 30 seconds if graceful shutdown fails
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Start server
server.listen(PORT, () => {
  logger.info(
    { port: PORT, serverId: SERVER_ID },
    `Server running on http://localhost:${PORT}`
  );
  logger.info(`WebSocket available at ws://localhost:${PORT}/ws`);
  logger.info(`Metrics available at http://localhost:${PORT}/metrics`);
  logger.info(`Health check at http://localhost:${PORT}/health`);

  // Try to connect to RabbitMQ in the background
  queueManager.connect().catch((error) => {
    logger.warn({ error }, 'RabbitMQ connection failed on startup (will retry)');
  });
});

export default app;
