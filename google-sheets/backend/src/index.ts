/**
 * Main entry point for the Google Sheets backend server.
 * Sets up Express HTTP server with WebSocket support for real-time collaboration.
 * Configures CORS, JSON parsing, API routes, structured logging, and metrics.
 *
 * @module index
 */

import express, { Request } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';
import pinoHttp from 'pino-http';
import apiRoutes from './api/routes.js';
import { setupWebSocket } from './websocket/server.js';
import logger from './shared/logger.js';
import { register, healthCheckStatus, dbPoolConnectionsActive } from './shared/metrics.js';
import { pool } from './shared/db.js';
import { redis } from './shared/redis.js';

const app = express();

/** Server port, configurable via PORT environment variable */
const PORT = parseInt(process.env.PORT || '3001');

// Request logging middleware with pino
app.use(pinoHttp.default({
  logger,
  // Don't log health check requests
  autoLogging: {
    ignore: (req: Request) => req.url === '/health' || req.url === '/ready' || req.url === '/metrics',
  },
}));

// Middleware
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

/**
 * Prometheus metrics endpoint.
 * Exposes all application metrics for scraping.
 */
app.get('/metrics', async (req, res) => {
  try {
    // Update pool metrics before returning
    dbPoolConnectionsActive.set(pool.totalCount);

    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error({ error }, 'Error generating metrics');
    res.status(500).end();
  }
});

/**
 * Comprehensive health check endpoint for monitoring and load balancer probes.
 * Checks database and Redis connectivity.
 * Returns detailed status of all dependencies.
 */
app.get('/health', async (req, res) => {
  const checks: Record<string, boolean | string | number> = {};
  let isHealthy = true;

  // Check database
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    const duration = Date.now() - start;
    checks.database = true;
    checks.database_latency_ms = duration;
    healthCheckStatus.labels('database').set(1);
  } catch (error) {
    checks.database = false;
    checks.database_error = (error as Error).message;
    isHealthy = false;
    healthCheckStatus.labels('database').set(0);
    logger.error({ error }, 'Health check: database failed');
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    const duration = Date.now() - start;
    checks.redis = true;
    checks.redis_latency_ms = duration;
    healthCheckStatus.labels('redis').set(1);
  } catch (error) {
    checks.redis = false;
    checks.redis_error = (error as Error).message;
    isHealthy = false;
    healthCheckStatus.labels('redis').set(0);
    logger.error({ error }, 'Health check: redis failed');
  }

  const status = isHealthy ? 'healthy' : 'unhealthy';

  res.status(isHealthy ? 200 : 503).json({
    status,
    service: 'google-sheets',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    checks,
  });
});

/**
 * Readiness check endpoint for traffic routing.
 * Returns 200 only when the service is ready to handle requests.
 * Use this for Kubernetes readiness probes.
 */
app.get('/ready', async (req, res) => {
  try {
    // Quick check - both DB and Redis must be available
    await Promise.all([
      pool.query('SELECT 1'),
      redis.ping(),
    ]);

    res.status(200).json({ ready: true });
  } catch (error) {
    logger.warn({ error }, 'Readiness check failed');
    res.status(503).json({ ready: false });
  }
});

// API routes
app.use('/api', apiRoutes);

// Create HTTP server
const server = createServer(app);

// Setup WebSocket
const wss = setupWebSocket(server);

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, starting graceful shutdown');

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Close WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });

  // Close database pool
  await pool.end();
  logger.info('Database pool closed');

  // Close Redis connections
  await redis.quit();
  logger.info('Redis connection closed');

  process.exit(0);
});

// Start server
server.listen(PORT, () => {
  logger.info({ port: PORT }, 'Google Sheets server started');
  logger.info({ wsPath: `/ws` }, 'WebSocket available');
  logger.info({ metricsPath: '/metrics' }, 'Prometheus metrics available');
  logger.info({ healthPath: '/health' }, 'Health check available');
});
