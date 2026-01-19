/**
 * @fileoverview Main entry point for the Slack backend server.
 * Sets up Express with middleware, REST API routes, WebSocket connections,
 * and initializes connections to Redis and Elasticsearch services.
 * Includes Prometheus metrics, structured logging, and health checks.
 */

import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import dotenv from 'dotenv';
import { v4 as uuidv4 } from 'uuid';

import authRoutes from './routes/auth.js';
import workspaceRoutes from './routes/workspaces.js';
import channelRoutes from './routes/channels.js';
import dmRoutes from './routes/dms.js';
import messageRoutes from './routes/messages.js';
import searchRoutes from './routes/search.js';

import { setupWebSocket, getConnectedUsersCount } from './services/websocket.js';
import { initializeElasticsearch } from './services/elasticsearch.js';
import { redis } from './services/redis.js';
import { logger, createRequestLogger } from './services/logger.js';
import {
  getMetrics,
  getMetricsContentType,
  httpRequestDurationHistogram,
  httpRequestsCounter,
  websocketUsersGauge,
} from './services/metrics.js';
import { pool } from './db/index.js';

dotenv.config();

const app = express();
const server = createServer(app);
const PORT = process.env.PORT || 3000;

// ============================================================================
// Middleware
// ============================================================================

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Session configuration
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-session-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));

/**
 * Request logging and metrics middleware.
 * Adds request ID, logs request/response, and records HTTP metrics.
 */
app.use((req, res, next) => {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  const startTime = Date.now();

  // Add request ID to response headers
  res.setHeader('X-Request-ID', requestId);

  // Create request-scoped logger
  const reqLogger = createRequestLogger(requestId, req.session?.userId, req.session?.workspaceId);
  (req as express.Request & { log: typeof reqLogger }).log = reqLogger;

  // Log incoming request
  reqLogger.info({
    msg: 'Incoming request',
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip,
  });

  // Capture response for logging
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const durationSeconds = duration / 1000;

    // Normalize route for metrics (replace UUIDs and IDs with placeholders)
    const normalizedRoute = req.route?.path || req.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id').replace(/\/\d+/g, '/:id');

    // Record metrics
    httpRequestDurationHistogram.observe(
      { method: req.method, route: normalizedRoute, status_code: res.statusCode },
      durationSeconds
    );
    httpRequestsCounter.inc({ method: req.method, route: normalizedRoute, status_code: res.statusCode });

    // Log response
    reqLogger.info({
      msg: 'Request completed',
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
    });
  });

  next();
});

// ============================================================================
// Health Check and Metrics Endpoints
// ============================================================================

/**
 * Basic health check endpoint.
 * Returns 200 if the server is running.
 */
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Detailed health check endpoint.
 * Checks connectivity to Redis, PostgreSQL, and Elasticsearch.
 */
app.get('/health/detailed', async (req, res) => {
  const health: {
    status: 'healthy' | 'degraded' | 'unhealthy';
    timestamp: string;
    services: {
      redis: { status: string; latencyMs?: number };
      postgres: { status: string; latencyMs?: number };
      elasticsearch: { status: string };
      websocket: { status: string; connectedUsers: number };
    };
  } = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    services: {
      redis: { status: 'unknown' },
      postgres: { status: 'unknown' },
      elasticsearch: { status: 'unknown' },
      websocket: { status: 'connected', connectedUsers: getConnectedUsersCount() },
    },
  };

  try {
    // Check Redis
    const redisStart = Date.now();
    await redis.ping();
    health.services.redis = { status: 'connected', latencyMs: Date.now() - redisStart };
  } catch (_error) {
    health.services.redis = { status: 'disconnected' };
    health.status = 'degraded';
  }

  try {
    // Check PostgreSQL
    const pgStart = Date.now();
    await pool.query('SELECT 1');
    health.services.postgres = { status: 'connected', latencyMs: Date.now() - pgStart };
  } catch (_error) {
    health.services.postgres = { status: 'disconnected' };
    health.status = 'unhealthy';
  }

  // Elasticsearch status is best-effort (might not be configured)
  health.services.elasticsearch = { status: process.env.ELASTICSEARCH_URL ? 'configured' : 'not_configured' };

  // Update WebSocket metrics
  websocketUsersGauge.set(health.services.websocket.connectedUsers);

  const statusCode = health.status === 'healthy' ? 200 : health.status === 'degraded' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * Prometheus metrics endpoint.
 * Returns metrics in Prometheus text format for scraping.
 */
app.get('/metrics', async (req, res) => {
  try {
    // Update WebSocket gauge before returning metrics
    websocketUsersGauge.set(getConnectedUsersCount());

    res.set('Content-Type', getMetricsContentType());
    res.send(await getMetrics());
  } catch (error) {
    logger.error({ err: error, msg: 'Failed to generate metrics' });
    res.status(500).send('Failed to generate metrics');
  }
});

/**
 * Readiness probe for container orchestration.
 * Returns 200 only when all critical services are available.
 */
app.get('/ready', async (req, res) => {
  try {
    await Promise.all([
      redis.ping(),
      pool.query('SELECT 1'),
    ]);
    res.status(200).json({ ready: true });
  } catch (_error) {
    res.status(503).json({ ready: false, reason: 'Critical service unavailable' });
  }
});

/**
 * Liveness probe for container orchestration.
 * Returns 200 if the process is running (doesn't check external services).
 */
app.get('/live', (req, res) => {
  res.status(200).json({ live: true });
});

// ============================================================================
// API Routes
// ============================================================================

app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/channels', channelRoutes);
app.use('/api/dms', dmRoutes);
app.use('/api/messages', messageRoutes);
app.use('/api/search', searchRoutes);

// ============================================================================
// Error Handler
// ============================================================================

app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const requestId = res.getHeader('X-Request-ID');
  logger.error({
    err,
    msg: 'Unhandled error',
    requestId,
    method: req.method,
    path: req.path,
  });
  res.status(500).json({
    error: 'Internal server error',
    requestId,
  });
});

// ============================================================================
// Server Startup
// ============================================================================

// Setup WebSocket
setupWebSocket(server);

/**
 * Initializes all services and starts the HTTP server.
 * Verifies Redis connectivity, initializes Elasticsearch index creation
 * (non-blocking), and begins listening for HTTP/WebSocket connections.
 * Exits the process if critical services (Redis) fail to connect.
 * @returns Promise that resolves when server is listening
 */
async function start(): Promise<void> {
  try {
    // Test Redis connection
    await redis.ping();
    logger.info({ msg: 'Redis connected' });

    // Test PostgreSQL connection
    await pool.query('SELECT 1');
    logger.info({ msg: 'PostgreSQL connected' });

    // Initialize Elasticsearch (non-blocking)
    initializeElasticsearch().catch((err) => {
      logger.warn({ err, msg: 'Elasticsearch initialization failed - search may be unavailable' });
    });

    server.listen(PORT, () => {
      logger.info({
        msg: 'Server started',
        port: PORT,
        websocket: `ws://localhost:${PORT}/ws`,
        metrics: `http://localhost:${PORT}/metrics`,
        health: `http://localhost:${PORT}/health`,
      });
    });
  } catch (error) {
    logger.fatal({ err: error, msg: 'Failed to start server' });
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info({ msg: 'SIGTERM received, shutting down gracefully' });
  server.close(() => {
    logger.info({ msg: 'HTTP server closed' });
    pool.end().then(() => {
      logger.info({ msg: 'PostgreSQL pool closed' });
      redis.quit().then(() => {
        logger.info({ msg: 'Redis connection closed' });
        process.exit(0);
      });
    });
  });
});

start();
