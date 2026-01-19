/**
 * WhatsApp Backend Server Entry Point
 *
 * This module initializes and configures the Express server with:
 * - Session management via Redis for distributed session storage
 * - CORS configuration for frontend communication
 * - RESTful API routes for auth, conversations, and messages
 * - WebSocket server for real-time messaging
 * - Prometheus metrics endpoint for observability
 * - Structured JSON logging with pino
 * - Health check endpoint with detailed component status
 * - Rate limiting for abuse prevention
 *
 * The server supports horizontal scaling by using Redis for session
 * storage and pub/sub for cross-server WebSocket message routing.
 */

import express from 'express';
import { createServer } from 'http';
import session from 'express-session';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import RedisStore from 'connect-redis';
import { config } from './config.js';
import { redis } from './redis.js';
import { pool, testConnection } from './db.js';
import { setupWebSocket, getConnectionCount } from './websocket/index.js';
import authRoutes from './routes/auth.js';
import conversationRoutes from './routes/conversations.js';
import messageRoutes from './routes/messages.js';

// Shared modules for observability and resilience
import { logger, httpLogger, createServiceLogger } from './shared/logger.js';
import { getMetrics, metricsMiddleware, websocketConnections } from './shared/metrics.js';
import { loginRateLimiter, registerRateLimiter } from './shared/rateLimiter.js';
import { getCircuitBreakerStatus } from './shared/circuitBreaker.js';

const serverLogger = createServiceLogger('server');

const app = express();
const server = createServer(app);

// Trust proxy for proper client IP in rate limiting
app.set('trust proxy', 1);

// CORS
app.use(
  cors({
    origin: config.cors.origin,
    credentials: true,
  })
);

// Body parsing
app.use(express.json());
app.use(cookieParser());

// Structured HTTP request logging
app.use(httpLogger);

// Prometheus metrics middleware
app.use(metricsMiddleware);

// Session middleware with Redis store
const sessionStore = new (RedisStore as any)({
  client: redis,
  prefix: 'sess:',
});

const sessionMiddleware = session({
  store: sessionStore,
  secret: config.session.secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: config.session.maxAge,
    sameSite: 'lax',
  },
});

app.use(sessionMiddleware);

// Routes with rate limiting
app.use('/api/auth/login', loginRateLimiter);
app.use('/api/auth/register', registerRateLimiter);
app.use('/api/auth', authRoutes);
app.use('/api/conversations', conversationRoutes);
app.use('/api/messages', messageRoutes);

/**
 * Prometheus metrics endpoint.
 * Exposes all application metrics in Prometheus text format.
 *
 * Metrics include:
 * - whatsapp_messages_total: Counter of messages by status
 * - whatsapp_message_delivery_duration_seconds: Histogram of delivery latency
 * - whatsapp_websocket_connections_total: Current WebSocket connections
 * - whatsapp_http_request_duration_seconds: API response times
 * - whatsapp_rate_limit_hits_total: Rate limiting events
 * - whatsapp_circuit_breaker_state: Circuit breaker status
 */
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', 'text/plain');
    res.send(await getMetrics());
  } catch (error) {
    serverLogger.error({ error }, 'Failed to get metrics');
    res.status(500).send('Error getting metrics');
  }
});

/**
 * Detailed health check endpoint.
 * Reports status of all system components for monitoring and alerting.
 *
 * Returns:
 * - status: 'healthy', 'degraded', or 'unhealthy'
 * - checks: Individual component status
 * - server: Server identification
 * - connections: WebSocket connection count
 */
app.get('/health', async (req, res) => {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};
  let overallStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';

  // Check PostgreSQL
  try {
    const start = Date.now();
    const dbConnected = await testConnection();
    const latency = Date.now() - start;

    checks.database = dbConnected
      ? { status: 'healthy', latency }
      : { status: 'unhealthy', error: 'Connection failed' };

    if (!dbConnected) overallStatus = 'unhealthy';
  } catch (error) {
    checks.database = { status: 'unhealthy', error: String(error) };
    overallStatus = 'unhealthy';
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    const latency = Date.now() - start;
    checks.redis = { status: 'healthy', latency };
  } catch (error) {
    checks.redis = { status: 'unhealthy', error: String(error) };
    if (overallStatus === 'healthy') overallStatus = 'degraded';
  }

  // Check circuit breakers
  const circuitStatus = getCircuitBreakerStatus();
  checks.circuits = {
    status:
      circuitStatus.redis.state === 'closed' && circuitStatus.database.state === 'closed'
        ? 'healthy'
        : circuitStatus.redis.state === 'open' || circuitStatus.database.state === 'open'
          ? 'unhealthy'
          : 'degraded',
  };

  if (checks.circuits.status === 'unhealthy' && overallStatus !== 'unhealthy') {
    overallStatus = 'degraded';
  }

  // Get memory usage
  const memUsage = process.memoryUsage();
  const memoryMB = Math.round(memUsage.heapUsed / 1024 / 1024);

  const healthResponse = {
    status: overallStatus,
    server: config.serverId,
    timestamp: new Date().toISOString(),
    uptime: Math.round(process.uptime()),
    connections: getConnectionCount(),
    memory: {
      heapUsed: memoryMB,
      heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024),
    },
    checks,
    circuits: circuitStatus,
  };

  const statusCode = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 200 : 503;
  res.status(statusCode).json(healthResponse);
});

/**
 * Liveness probe for Kubernetes.
 * Simple check that the process is running.
 */
app.get('/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

/**
 * Readiness probe for Kubernetes.
 * Checks if the server can accept traffic.
 */
app.get('/ready', async (req, res) => {
  try {
    const dbConnected = await testConnection();
    await redis.ping();

    if (dbConnected) {
      res.status(200).json({ status: 'ready' });
    } else {
      res.status(503).json({ status: 'not ready', reason: 'Database unavailable' });
    }
  } catch (error) {
    res.status(503).json({ status: 'not ready', reason: String(error) });
  }
});

// Setup WebSocket with session middleware
setupWebSocket(server, sessionMiddleware);

// Start server
server.listen(config.port, () => {
  serverLogger.info({
    port: config.port,
    serverId: config.serverId,
    cors: config.cors.origin,
  }, `Server ${config.serverId} started`);

  console.log(`Server ${config.serverId} listening on port ${config.port}`);
  console.log(`WebSocket available at ws://localhost:${config.port}/ws`);
  console.log(`Metrics available at http://localhost:${config.port}/metrics`);
  console.log(`Health check at http://localhost:${config.port}/health`);
  console.log(`CORS origin: ${config.cors.origin}`);
});

// Update WebSocket connection gauge periodically
setInterval(() => {
  websocketConnections.set(getConnectionCount());
}, 5000);

// Graceful shutdown
const shutdown = async (signal: string) => {
  serverLogger.info({ signal }, 'Shutdown signal received');
  console.log(`${signal} received, shutting down gracefully...`);

  // Stop accepting new connections
  server.close(async () => {
    serverLogger.info('HTTP server closed');

    // Close database pool
    try {
      await pool.end();
      serverLogger.info('Database pool closed');
    } catch (error) {
      serverLogger.error({ error }, 'Error closing database pool');
    }

    // Close Redis connections
    try {
      await redis.quit();
      serverLogger.info('Redis connection closed');
    } catch (error) {
      serverLogger.error({ error }, 'Error closing Redis connection');
    }

    serverLogger.info('Shutdown complete');
    process.exit(0);
  });

  // Force shutdown after 10 seconds
  setTimeout(() => {
    serverLogger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Unhandled error logging
process.on('uncaughtException', (error) => {
  serverLogger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  serverLogger.error({ reason, promise }, 'Unhandled rejection');
});
