/**
 * FaceTime Backend Server Entry Point
 *
 * This module bootstraps the Express HTTP server with WebSocket support
 * for real-time video calling signaling. It initializes database and Redis
 * connections, mounts REST API routes, and configures the WebSocket server
 * for call signaling.
 *
 * Features:
 * - Prometheus metrics at /metrics
 * - Structured JSON logging with pino
 * - Health check with dependency status
 * - Circuit breaker for resilience
 */

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { v4 as uuidv4 } from 'uuid';

import { testConnection } from './db/index.js';
import { getRedisClient } from './services/redis.js';
import { setupWebSocketServer, getOnlineUsers, getClientCount } from './services/signaling.js';
import usersRouter from './routes/users.js';
import callsRouter from './routes/calls.js';

// Shared modules
import { logger, createRequestLogger, logAudit } from './shared/logger.js';
import { getMetrics, getContentType, activeConnections } from './shared/metrics.js';
import { getCircuitBreakerStates } from './shared/circuit-breaker.js';

// Extend Express Request to include logger
declare global {
  namespace Express {
    interface Request {
      log: ReturnType<typeof createRequestLogger>;
      requestId: string;
    }
  }
}

/** Express application instance */
const app = express();

/** Server port from environment or default 3001 */
const PORT = parseInt(process.env.PORT || '3001');

// ============================================================================
// Middleware
// ============================================================================

app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true,
}));

app.use(helmet({
  contentSecurityPolicy: false, // Disable for WebSocket compatibility
}));

// Request logging middleware (replaces morgan)
app.use((req: Request, res: Response, next: NextFunction) => {
  const requestId = (req.headers['x-request-id'] as string) || uuidv4();
  req.requestId = requestId;
  req.log = createRequestLogger(requestId, req.method, req.path);

  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

    req.log[level]({
      statusCode: res.statusCode,
      durationMs: duration,
      contentLength: res.get('content-length'),
    }, 'request completed');
  });

  next();
});

app.use(express.json());

// ============================================================================
// Observability Endpoints
// ============================================================================

/**
 * Prometheus metrics endpoint.
 * Returns metrics in Prometheus exposition format for scraping.
 */
app.get('/metrics', async (_req: Request, res: Response) => {
  try {
    res.set('Content-Type', getContentType());
    res.send(await getMetrics());
  } catch (error) {
    logger.error({ error }, 'Error generating metrics');
    res.status(500).send('Error generating metrics');
  }
});

/**
 * Health check endpoint.
 * Returns database, Redis, and circuit breaker status for monitoring.
 * Used by load balancers and orchestrators for health probes.
 */
app.get('/health', async (req: Request, res: Response) => {
  const startTime = Date.now();

  // Check database
  let dbOk = false;
  let dbLatencyMs = 0;
  try {
    const dbStart = Date.now();
    dbOk = await testConnection();
    dbLatencyMs = Date.now() - dbStart;
  } catch {
    dbOk = false;
  }

  // Check Redis
  let redisOk = false;
  let redisLatencyMs = 0;
  try {
    const redisStart = Date.now();
    const redis = await getRedisClient();
    await redis.ping();
    redisLatencyMs = Date.now() - redisStart;
    redisOk = true;
  } catch {
    redisOk = false;
  }

  // Get circuit breaker states
  const circuitBreakers = getCircuitBreakerStates();

  // Determine overall health
  const isHealthy = dbOk && redisOk;
  const status = isHealthy ? 'healthy' : 'degraded';

  const response = {
    status,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    latencyMs: Date.now() - startTime,
    dependencies: {
      database: {
        status: dbOk ? 'connected' : 'disconnected',
        latencyMs: dbLatencyMs,
      },
      redis: {
        status: redisOk ? 'connected' : 'disconnected',
        latencyMs: redisLatencyMs,
      },
    },
    circuitBreakers,
    process: {
      memory: process.memoryUsage(),
      pid: process.pid,
    },
  };

  res.status(isHealthy ? 200 : 503).json(response);
});

/**
 * Liveness probe endpoint.
 * Simple check that the process is running.
 */
app.get('/health/live', (_req: Request, res: Response) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

/**
 * Readiness probe endpoint.
 * Checks if the service is ready to accept traffic.
 */
app.get('/health/ready', async (_req: Request, res: Response) => {
  try {
    const redis = await getRedisClient();
    await redis.ping();
    const dbOk = await testConnection();

    if (dbOk) {
      res.json({ status: 'ready', timestamp: new Date().toISOString() });
    } else {
      res.status(503).json({ status: 'not ready', reason: 'database unavailable' });
    }
  } catch {
    res.status(503).json({ status: 'not ready', reason: 'redis unavailable' });
  }
});

/**
 * Stats endpoint.
 * Returns current online users and total WebSocket connection count.
 */
app.get('/stats', (_req: Request, res: Response) => {
  const onlineUsers = getOnlineUsers();
  const totalConnections = getClientCount();

  // Update metrics
  activeConnections.set(totalConnections);

  res.json({
    onlineUsers,
    totalConnections,
    timestamp: new Date().toISOString(),
  });
});

/**
 * TURN/STUN credentials endpoint.
 * Returns ICE server configuration for WebRTC peer connections.
 * In production, this would generate time-limited credentials.
 */
app.get('/turn-credentials', (req: Request, res: Response) => {
  // Log audit event for credential request
  logAudit({
    timestamp: new Date().toISOString(),
    action: 'turn.credentials_requested',
    actor: {
      userId: 'anonymous', // Would be from auth in production
      ip: req.ip || req.socket.remoteAddress || 'unknown',
    },
    resource: {
      type: 'turn_credentials',
      id: 'default',
    },
    outcome: 'success',
  });

  res.json({
    iceServers: [
      // Google's public STUN servers
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      // Local coturn TURN server
      {
        urls: process.env.TURN_URL || 'turn:localhost:3478',
        username: process.env.TURN_USERNAME || 'facetime',
        credential: process.env.TURN_CREDENTIAL || 'facetime123',
      },
    ],
  });
});

// ============================================================================
// API Routes
// ============================================================================

app.use('/api/users', usersRouter);
app.use('/api/calls', callsRouter);

// Error handling middleware
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  req.log.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// Server Setup
// ============================================================================

/** HTTP server wrapping Express for WebSocket support */
const server = createServer(app);

/**
 * WebSocket server for real-time signaling.
 * Handles call initiation, answering, and WebRTC offer/answer exchange.
 */
const wss = new WebSocketServer({
  server,
  path: '/ws',
});

// Setup WebSocket handling
setupWebSocketServer(wss);

/**
 * Starts the server after verifying database and Redis connectivity.
 * Logs connection status and server URLs on successful startup.
 */
async function start() {
  try {
    // Test database connection
    const dbOk = await testConnection();
    if (!dbOk) {
      logger.error('Failed to connect to database. Make sure PostgreSQL is running.');
      logger.info('Run: docker-compose up -d postgres');
    }

    // Test Redis connection
    try {
      await getRedisClient();
      logger.info('Redis connection established');
    } catch (error) {
      logger.error({ error }, 'Failed to connect to Redis. Make sure Redis is running.');
      logger.info('Run: docker-compose up -d redis');
    }

    server.listen(PORT, () => {
      logger.info({
        port: PORT,
        env: process.env.NODE_ENV || 'development',
      }, 'FaceTime Signaling Server started');

      console.log(`\n=================================`);
      console.log(`FaceTime Signaling Server`);
      console.log(`=================================`);
      console.log(`HTTP Server: http://localhost:${PORT}`);
      console.log(`WebSocket: ws://localhost:${PORT}/ws`);
      console.log(`Health: http://localhost:${PORT}/health`);
      console.log(`Metrics: http://localhost:${PORT}/metrics`);
      console.log(`Stats: http://localhost:${PORT}/stats`);
      console.log(`=================================\n`);
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();

// ============================================================================
// Graceful Shutdown
// ============================================================================

async function shutdown(signal: string) {
  logger.info({ signal }, 'Shutdown signal received');

  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Close WebSocket connections
  wss.clients.forEach((client) => {
    client.close(1001, 'Server shutting down');
  });

  // Allow time for connections to close
  setTimeout(() => {
    logger.info('Exiting process');
    process.exit(0);
  }, 5000);
}

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
