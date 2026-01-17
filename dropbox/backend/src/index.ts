/**
 * Main application entry point for the Dropbox-clone backend.
 * Sets up Express server with REST API routes and WebSocket server for real-time sync.
 *
 * Features:
 * - REST API: /api/auth, /api/files, /api/share, /api/admin
 * - WebSocket: /ws for real-time sync notifications
 * - Prometheus metrics: /metrics for monitoring
 * - Health checks: /health/live, /health/ready, /health/deep
 * - Structured JSON logging with pino
 * - Rate limiting and CORS configuration
 * - Graceful shutdown handling
 *
 * @module index
 */

import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { WebSocketServer, WebSocket } from 'ws';
import http from 'http';
import crypto from 'crypto';

import authRoutes from './routes/auth.js';
import fileRoutes from './routes/files.js';
import sharingRoutes from './routes/sharing.js';
import adminRoutes from './routes/admin.js';
import healthRoutes from './routes/health.js';
import { redisSub, getSession } from './utils/redis.js';
import { pool } from './utils/database.js';
import { logger, createRequestLogger } from './shared/logger.js';
import {
  getMetrics,
  getMetricsContentType,
  httpRequestsTotal,
  httpRequestDuration,
  websocketConnectionsActive,
  syncEventsTotal,
} from './shared/metrics.js';

/** Server port from environment or default 3000 */
const PORT = parseInt(process.env.PORT || '3000', 10);

const app = express();

// ============================================================================
// Request Logging and Tracing Middleware
// ============================================================================

/**
 * Generates a unique trace ID for each request.
 * Used for correlating logs across a single request lifecycle.
 */
app.use((req, res, next) => {
  const traceId = req.headers['x-trace-id'] as string || crypto.randomUUID();
  (req as any).traceId = traceId;
  res.setHeader('X-Trace-Id', traceId);

  // Create request-scoped logger
  const requestLogger = createRequestLogger(traceId);
  (req as any).log = requestLogger;

  // Log request start
  requestLogger.debug({
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip,
  }, 'Request started');

  next();
});

// ============================================================================
// Middleware Configuration
// ============================================================================

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

/** Rate limiter to prevent abuse - 1000 requests per 15 minutes per IP */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // limit each IP to 1000 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ============================================================================
// Metrics Collection Middleware
// ============================================================================

/**
 * Middleware to collect HTTP request metrics for Prometheus.
 * Tracks request count, duration, and status codes.
 */
app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const durationSeconds = Number(end - start) / 1_000_000_000;

    // Normalize path to avoid high cardinality
    const normalizedPath = normalizePath(req.path);

    httpRequestsTotal
      .labels(req.method, normalizedPath, String(res.statusCode))
      .inc();

    httpRequestDuration
      .labels(req.method, normalizedPath, String(res.statusCode))
      .observe(durationSeconds);

    // Log request completion
    const requestLogger = (req as any).log || logger;
    requestLogger.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(durationSeconds * 1000),
    }, 'Request completed');
  });

  next();
});

/**
 * Normalizes request paths to reduce metric cardinality.
 * Replaces UUIDs and numeric IDs with placeholders.
 */
function normalizePath(path: string): string {
  return path
    // Replace UUIDs
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    // Replace numeric IDs
    .replace(/\/\d+/g, '/:id')
    // Replace share tokens
    .replace(/\/[a-f0-9]{32,64}/gi, '/:token');
}

// ============================================================================
// Health and Metrics Endpoints
// ============================================================================

/** Health check routes */
app.use('/health', healthRoutes);

/**
 * GET /metrics - Prometheus metrics endpoint.
 * Returns metrics in Prometheus text format.
 */
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.setHeader('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error }, 'Failed to collect metrics');
    res.status(500).send('Error collecting metrics');
  }
});

// ============================================================================
// API Route Mounting
// ============================================================================

app.use('/api/auth', authRoutes);
app.use('/api/files', fileRoutes);
app.use('/api/share', sharingRoutes);
app.use('/api/admin', adminRoutes);

// ============================================================================
// Error Handling
// ============================================================================

/** 404 handler for unknown routes */
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

/** Global error handler for uncaught exceptions in routes */
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const requestLogger = (req as any).log || logger;
  requestLogger.error({
    error: err.message,
    stack: err.stack,
  }, 'Unhandled error');

  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// HTTP Server and WebSocket Setup
// ============================================================================

/** HTTP server wrapping Express for WebSocket support */
const server = http.createServer(app);

/**
 * WebSocket server for real-time sync notifications.
 * Clients connect with ?token=sessionToken to authenticate.
 * Receives file change events via Redis pub/sub and forwards to connected clients.
 */
const wss = new WebSocketServer({ server, path: '/ws' });

/** Map of user IDs to their active WebSocket connections */
const userConnections = new Map<string, Set<WebSocket>>();

/**
 * Handle new WebSocket connections.
 * Validates session token and subscribes connection to user's sync channel.
 */
wss.on('connection', async (ws, req) => {
  // Extract token from query string
  const url = new URL(req.url || '', `http://localhost:${PORT}`);
  const token = url.searchParams.get('token');

  if (!token) {
    ws.close(4001, 'Authentication required');
    return;
  }

  // Validate token
  const userId = await getSession(token);

  if (!userId) {
    ws.close(4001, 'Invalid token');
    return;
  }

  // Add to user connections
  if (!userConnections.has(userId)) {
    userConnections.set(userId, new Set());
  }
  userConnections.get(userId)!.add(ws);

  // Update metrics
  websocketConnectionsActive.inc();

  logger.info({ userId }, 'WebSocket connected');

  // Send initial connection message
  ws.send(JSON.stringify({ type: 'connected', userId }));

  ws.on('close', () => {
    const connections = userConnections.get(userId);
    if (connections) {
      connections.delete(ws);
      if (connections.size === 0) {
        userConnections.delete(userId);
      }
    }
    websocketConnectionsActive.dec();
    logger.info({ userId }, 'WebSocket disconnected');
  });

  ws.on('error', (error) => {
    logger.error({ userId, error }, 'WebSocket error');
  });
});

// ============================================================================
// Redis Pub/Sub for Sync Events
// ============================================================================

/**
 * Subscribe to Redis pub/sub for sync events.
 * Pattern sync:* matches all user-specific sync channels.
 */
redisSub.psubscribe('sync:*', (err) => {
  if (err) {
    logger.error({ error: err }, 'Failed to subscribe to sync events');
  } else {
    logger.info('Subscribed to sync events');
  }
});

/**
 * Forward sync events from Redis to connected WebSocket clients.
 * Parses channel name to find target user and broadcasts to their connections.
 */
redisSub.on('pmessage', (pattern, channel, message) => {
  // Extract user ID from channel (sync:userId)
  const userId = channel.split(':')[1];
  const connections = userConnections.get(userId);

  if (connections) {
    // Parse message to track event type in metrics
    try {
      const event = JSON.parse(message);
      syncEventsTotal.labels(event.type || 'unknown').inc();
    } catch {
      // Ignore parse errors for metrics
    }

    connections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }
});

// ============================================================================
// Graceful Shutdown
// ============================================================================

/**
 * Graceful shutdown handler.
 * Closes WebSocket connections and database pool before exiting.
 */
async function gracefulShutdown(signal: string) {
  logger.info({ signal }, 'Graceful shutdown initiated');

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Close WebSocket connections
  wss.clients.forEach((ws) => {
    ws.close(1001, 'Server shutting down');
  });
  logger.info('WebSocket connections closed');

  // Close Redis subscriptions
  try {
    await redisSub.punsubscribe('sync:*');
    await redisSub.quit();
    logger.info('Redis subscriptions closed');
  } catch (error) {
    logger.error({ error }, 'Error closing Redis');
  }

  // Close database pool
  try {
    await pool.end();
    logger.info('Database pool closed');
  } catch (error) {
    logger.error({ error }, 'Error closing database pool');
  }

  logger.info('Graceful shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
});

// ============================================================================
// Server Startup
// ============================================================================

/** Start the server and log connection info */
server.listen(PORT, () => {
  logger.info({
    port: PORT,
    env: process.env.NODE_ENV || 'development',
  }, 'Server started');
  logger.info(`API available at http://localhost:${PORT}`);
  logger.info(`WebSocket available at ws://localhost:${PORT}/ws`);
  logger.info(`Metrics available at http://localhost:${PORT}/metrics`);
  logger.info(`Health check at http://localhost:${PORT}/health/deep`);
});
