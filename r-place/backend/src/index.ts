/**
 * Main application entry point for the r/place backend server.
 *
 * Initializes and starts:
 * - Express HTTP server with middleware and metrics
 * - WebSocket server for real-time updates
 * - Periodic canvas snapshot scheduler
 * - Graceful shutdown handlers
 */
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer, Server } from 'http';

import authRoutes from './routes/auth.js';
import canvasRoutes from './routes/canvas.js';
import { setupWebSocket, shutdownWebSocket } from './websocket.js';
import { canvasService } from './services/canvas.js';
import { redis } from './services/redis.js';
import { pool } from './services/database.js';
import { SNAPSHOT_INTERVAL_MS } from './config.js';
import { logger } from './shared/logger.js';
import {
  metricsMiddleware,
  getMetrics,
  getMetricsContentType,
  snapshotsCreatedTotal,
} from './shared/metrics.js';

const app = express();
const server: Server = createServer(app);

/** Server port, configurable via PORT environment variable. */
const PORT = parseInt(process.env.PORT || '3000');

/** Server start time for uptime calculation. */
const startTime = Date.now();

/** Application version from package.json or environment. */
const VERSION = process.env.npm_package_version || '1.0.0';

/**
 * Middleware configuration.
 * - CORS: Allows frontend to make credentialed requests
 * - JSON: Parses JSON request bodies
 * - Cookie: Parses session cookies
 * - Metrics: Tracks HTTP request metrics
 */
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(metricsMiddleware as unknown as (req: Request, res: Response, next: NextFunction) => void);

/** Route mounting for API endpoints. */
app.use('/api/auth', authRoutes);
app.use('/api/canvas', canvasRoutes);

/**
 * GET /health - Basic liveness check.
 * Returns 200 if the server process is running.
 * Used by load balancers for quick liveness probes.
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: VERSION,
  });
});

/**
 * GET /health/ready - Readiness check.
 * Verifies connectivity to Redis and PostgreSQL.
 * Used by load balancers to determine if the server can handle requests.
 */
app.get('/health/ready', async (req: Request, res: Response) => {
  const health: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    redis: 'connected' | 'disconnected';
    postgres: 'connected' | 'disconnected';
    timestamp: string;
    uptime: number;
    version: string;
    checks: { redis: { latencyMs: number }; postgres: { latencyMs: number } };
  } = {
    status: 'healthy',
    redis: 'disconnected',
    postgres: 'disconnected',
    timestamp: new Date().toISOString(),
    uptime: Math.floor((Date.now() - startTime) / 1000),
    version: VERSION,
    checks: {
      redis: { latencyMs: -1 },
      postgres: { latencyMs: -1 },
    },
  };

  // Check Redis
  try {
    const redisStart = Date.now();
    await redis.ping();
    health.redis = 'connected';
    health.checks.redis.latencyMs = Date.now() - redisStart;
  } catch (error) {
    logger.error({ error }, 'Redis health check failed');
    health.status = 'unhealthy';
  }

  // Check PostgreSQL
  try {
    const pgStart = Date.now();
    await pool.query('SELECT 1');
    health.postgres = 'connected';
    health.checks.postgres.latencyMs = Date.now() - pgStart;
  } catch (error) {
    logger.error({ error }, 'PostgreSQL health check failed');
    health.status = 'unhealthy';
  }

  // Set degraded if one component is down but not both
  if (health.redis === 'disconnected' && health.postgres === 'connected') {
    health.status = 'degraded';
  }

  const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * GET /metrics - Prometheus metrics endpoint.
 * Returns all application and Node.js metrics in Prometheus exposition format.
 */
app.get('/metrics', async (req: Request, res: Response) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error }, 'Failed to collect metrics');
    res.status(500).send('Failed to collect metrics');
  }
});

/**
 * GET /api - API information endpoint.
 * Returns available endpoints and version information.
 */
app.get('/api', (req: Request, res: Response) => {
  res.json({
    name: 'r/place API',
    version: VERSION,
    endpoints: {
      auth: '/api/auth',
      canvas: '/api/canvas',
      websocket: '/ws',
      health: '/health',
      healthReady: '/health/ready',
      metrics: '/metrics',
    },
  });
});

/** WebSocket server instance for graceful shutdown. */
let wss: ReturnType<typeof setupWebSocket>;

/** Snapshot scheduler interval reference. */
let snapshotInterval: NodeJS.Timeout;

/**
 * Starts the server and initializes all required services.
 * - Initializes or loads existing canvas state
 * - Starts periodic snapshot scheduler
 * - Begins listening for HTTP/WebSocket connections
 */
async function start() {
  try {
    // Initialize canvas
    await canvasService.initializeCanvas();

    // Initialize WebSocket server
    wss = setupWebSocket(server);

    // Start snapshot scheduler
    snapshotInterval = setInterval(async () => {
      await canvasService.createSnapshot();
      snapshotsCreatedTotal.inc();
    }, SNAPSHOT_INTERVAL_MS);

    // Start HTTP server
    server.listen(PORT, () => {
      logger.info(
        {
          port: PORT,
          wsPath: '/ws',
          apiPath: '/api',
          metricsPath: '/metrics',
        },
        `Server running on port ${PORT}`
      );
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

/**
 * Graceful shutdown handler.
 * Properly closes all connections and cleans up resources.
 */
async function shutdown(signal: string) {
  logger.info({ signal }, `${signal} received, starting graceful shutdown`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Clear the snapshot interval
  if (snapshotInterval) {
    clearInterval(snapshotInterval);
    logger.info('Snapshot scheduler stopped');
  }

  // Gracefully close WebSocket connections
  if (wss) {
    await shutdownWebSocket(wss);
    logger.info('WebSocket server closed');
  }

  // Close Redis connections
  try {
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (error) {
    logger.error({ error }, 'Error closing Redis connection');
  }

  // Close PostgreSQL pool
  try {
    await pool.end();
    logger.info('PostgreSQL pool closed');
  } catch (error) {
    logger.error({ error }, 'Error closing PostgreSQL pool');
  }

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

start();
