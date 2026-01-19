/**
 * Main entry point for the Figma clone backend server.
 * Sets up Express with CORS, JSON parsing, REST API routes, and WebSocket support.
 * Includes health checks, metrics endpoints, and structured logging.
 */
import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import { createServer } from 'http';
import pool, { testConnection } from './db/postgres.js';
import redis from './db/redis.js';
import { setupWebSocket, getFileUserCount, getTotalConnections } from './websocket/handler.js';
import filesRouter from './routes/files.js';
import {
  logger,
  getMetrics,
  getMetricsContentType,
  getCircuitBreakerHealth,
  scheduleCleanupTasks,
  totalConnectionsGauge,
} from './shared/index.js';

const app = express();

/** Server port, configurable via environment variable */
const PORT = parseInt(process.env.PORT || '3000');

/** Server start time for uptime calculation */
const startTime = Date.now();

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Request logging middleware
app.use((req: Request, _res: Response, next: NextFunction) => {
  logger.debug({
    method: req.method,
    path: req.path,
    query: req.query,
  }, 'Incoming request');
  next();
});

/**
 * Comprehensive health check endpoint.
 * Reports status of all dependencies and circuit breakers.
 */
app.get('/health', async (_req: Request, res: Response) => {
  const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

  // Check PostgreSQL
  let postgresHealth: { connected: boolean; latency_ms?: number } = { connected: false };
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    postgresHealth = {
      connected: true,
      latency_ms: Date.now() - start,
    };
  } catch {
    postgresHealth = { connected: false };
  }

  // Check Redis
  let redisHealth: { connected: boolean; latency_ms?: number } = { connected: false };
  try {
    const start = Date.now();
    await redis.ping();
    redisHealth = {
      connected: true,
      latency_ms: Date.now() - start,
    };
  } catch {
    redisHealth = { connected: false };
  }

  // Get WebSocket stats
  const wsConnections = getTotalConnections();
  totalConnectionsGauge.set(wsConnections);

  // Get circuit breaker states
  const circuitBreakers = getCircuitBreakerHealth();

  // Determine overall health
  const isHealthy = postgresHealth.connected && redisHealth.connected;

  const healthResponse = {
    status: isHealthy ? 'healthy' : 'degraded',
    uptime_seconds: uptimeSeconds,
    timestamp: new Date().toISOString(),
    postgres: postgresHealth,
    redis: redisHealth,
    websocket: {
      connections: wsConnections,
      state: 'healthy',
    },
    circuit_breakers: circuitBreakers,
  };

  res.status(isHealthy ? 200 : 503).json(healthResponse);
});

/**
 * Prometheus metrics endpoint.
 * Exposes all application metrics for scraping.
 */
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error }, 'Failed to get metrics');
    res.status(500).send('Failed to get metrics');
  }
});

/**
 * Liveness probe for container orchestration.
 * Simple check that the server is running.
 */
app.get('/health/live', (_req: Request, res: Response) => {
  res.json({ status: 'alive' });
});

/**
 * Readiness probe for container orchestration.
 * Checks if the server is ready to handle requests.
 */
app.get('/health/ready', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'not_ready' });
  }
});

// API routes
app.use('/api/files', filesRouter);

// Error handling middleware
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// Create HTTP server
const server = createServer(app);

// Setup WebSocket
setupWebSocket(server);

/**
 * Starts the server after verifying database connectivity.
 * Logs connection status and available endpoints.
 */
async function start() {
  // Test database connection
  const dbConnected = await testConnection();
  if (!dbConnected) {
    logger.error('Failed to connect to database. Please ensure PostgreSQL is running.');
  }

  // Test Redis connection
  try {
    await redis.ping();
    logger.info('Redis connected successfully');
  } catch (error) {
    logger.error({ error }, 'Failed to connect to Redis');
  }

  // Schedule cleanup tasks
  if (process.env.ENABLE_CLEANUP !== 'false') {
    scheduleCleanupTasks();
  }

  server.listen(PORT, () => {
    logger.info({
      port: PORT,
      health: `http://localhost:${PORT}/health`,
      metrics: `http://localhost:${PORT}/metrics`,
      websocket: `ws://localhost:${PORT}/ws`,
    }, 'Server started');
  });
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  server.close(() => {
    logger.info('HTTP server closed');
    pool.end().then(() => {
      logger.info('Database connections closed');
      process.exit(0);
    });
  });
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  server.close(() => {
    pool.end().then(() => {
      process.exit(0);
    });
  });
});

start().catch((error) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
