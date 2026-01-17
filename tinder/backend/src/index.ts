import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import session from 'express-session';
import { createServer } from 'http';
import path from 'path';

import { testConnections, initElasticsearchIndex, redis, pool, elasticsearch } from './db/index.js';
import { WebSocketGateway } from './services/websocketGateway.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import discoveryRoutes from './routes/discovery.js';
import matchRoutes from './routes/matches.js';
import adminRoutes from './routes/admin.js';

import { logger } from './shared/logger.js';
import { serverConfig } from './shared/config.js';
import {
  getMetrics,
  getMetricsContentType,
  httpRequestsTotal,
  httpRequestDuration,
  websocketConnectionsGauge,
  dbPoolSizeGauge,
} from './shared/metrics.js';
import { apiRateLimiter } from './shared/rateLimit.js';
import { retentionService } from './shared/retention.js';

/**
 * Main application entry point for the Tinder-like matching platform backend.
 * Sets up Express server with WebSocket support for real-time messaging.
 * Includes Prometheus metrics, structured logging, and health checks.
 */

/** Express application instance */
const app = express();
/** HTTP server wrapping Express for WebSocket support */
const server = createServer(app);
/** Server port from environment or default 3000 */
const PORT = serverConfig.port;

// Request logging and metrics middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const path = req.route?.path || req.path;

    // Record metrics
    httpRequestsTotal.inc({
      method: req.method,
      path: path,
      status: res.statusCode.toString(),
    });

    httpRequestDuration.observe(
      { method: req.method, path: path, status: res.statusCode.toString() },
      duration
    );

    // Structured logging for requests
    logger.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration.toFixed(3)}s`,
      userId: req.session?.userId,
      ip: req.ip,
    }, 'HTTP request');
  });

  next();
});

// CORS middleware
app.use(cors({
  origin: serverConfig.frontendUrl,
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

// Session configuration
app.use(session({
  secret: serverConfig.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: serverConfig.nodeEnv === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'lax',
  },
}));

// Apply general rate limiting to API routes
app.use('/api', apiRateLimiter);

// Static file serving for uploads
app.use('/uploads', express.static(path.join(process.cwd(), 'uploads')));

/**
 * GET /metrics
 * Prometheus metrics endpoint.
 * Returns all application metrics in Prometheus text format.
 */
app.get('/metrics', async (_req, res) => {
  try {
    // Update pool metrics before returning
    const poolStatus = pool.totalCount !== undefined ? {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    } : { total: 0, idle: 0, waiting: 0 };

    dbPoolSizeGauge.set({ state: 'total' }, poolStatus.total);
    dbPoolSizeGauge.set({ state: 'idle' }, poolStatus.idle);
    dbPoolSizeGauge.set({ state: 'waiting' }, poolStatus.waiting);

    const metrics = await getMetrics();
    res.setHeader('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error }, 'Failed to get metrics');
    res.status(500).send('Failed to get metrics');
  }
});

/**
 * GET /health
 * Basic health check for load balancers.
 * Returns 200 if server is running.
 */
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * GET /api/health
 * Comprehensive health check endpoint for monitoring and load balancer health probes.
 * Returns connection status for all dependencies and system information.
 */
app.get('/api/health', async (_req, res) => {
  const healthStatus: {
    status: 'ok' | 'degraded' | 'unhealthy';
    timestamp: string;
    version: string;
    uptime: number;
    checks: {
      postgres: { status: string; latency?: number; error?: string };
      redis: { status: string; latency?: number; memory?: string; error?: string };
      elasticsearch: { status: string; latency?: number; error?: string };
    };
  } = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: serverConfig.version,
    uptime: process.uptime(),
    checks: {
      postgres: { status: 'unknown' },
      redis: { status: 'unknown' },
      elasticsearch: { status: 'unknown' },
    },
  };

  // Check PostgreSQL
  try {
    const pgStart = Date.now();
    await pool.query('SELECT 1');
    healthStatus.checks.postgres = {
      status: 'connected',
      latency: Date.now() - pgStart,
    };
  } catch (error) {
    healthStatus.checks.postgres = {
      status: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
    healthStatus.status = 'degraded';
  }

  // Check Redis
  try {
    const redisStart = Date.now();
    const pong = await redis.ping();
    const info = await redis.info('memory');
    const memoryMatch = info.match(/used_memory_human:(\S+)/);

    healthStatus.checks.redis = {
      status: pong === 'PONG' ? 'connected' : 'disconnected',
      latency: Date.now() - redisStart,
      memory: memoryMatch ? memoryMatch[1] : undefined,
    };
  } catch (error) {
    healthStatus.checks.redis = {
      status: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
    healthStatus.status = 'degraded';
  }

  // Check Elasticsearch
  try {
    const esStart = Date.now();
    await elasticsearch.ping();
    healthStatus.checks.elasticsearch = {
      status: 'connected',
      latency: Date.now() - esStart,
    };
  } catch (error) {
    healthStatus.checks.elasticsearch = {
      status: 'disconnected',
      error: error instanceof Error ? error.message : 'Unknown error',
    };
    // Elasticsearch is optional, only mark as degraded not unhealthy
    if (healthStatus.status === 'ok') {
      healthStatus.status = 'degraded';
    }
  }

  // If any critical service is down, mark as unhealthy
  if (
    healthStatus.checks.postgres.status === 'disconnected' ||
    healthStatus.checks.redis.status === 'disconnected'
  ) {
    healthStatus.status = 'unhealthy';
  }

  const statusCode = healthStatus.status === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json(healthStatus);
});

/**
 * GET /api/health/retention
 * Returns current retention configuration.
 */
app.get('/api/health/retention', (_req, res) => {
  res.json(retentionService.getRetentionConfig());
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/discovery', discoveryRoutes);
app.use('/api/matches', matchRoutes);
app.use('/api/admin', adminRoutes);

/** Global error handler for uncaught exceptions */
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ error: err, stack: err.stack }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

/** WebSocket gateway instance for real-time messaging */
let wsGateway: WebSocketGateway;

/**
 * Initializes all services and starts the HTTP server.
 * Tests database connections, initializes Elasticsearch index, and sets up WebSocket gateway.
 */
async function start() {
  try {
    logger.info('Testing database connections...');
    await testConnections();

    logger.info('Initializing Elasticsearch index...');
    await initElasticsearchIndex();

    // Initialize WebSocket
    wsGateway = new WebSocketGateway(server);
    logger.info('WebSocket gateway initialized');

    // Update WebSocket connection gauge periodically
    setInterval(() => {
      if (wsGateway) {
        // The gateway tracks connections internally
        websocketConnectionsGauge.set(wsGateway.getConnectionCount?.() || 0);
      }
    }, 5000);

    server.listen(PORT, () => {
      logger.info({ port: PORT }, 'Server started');
      logger.info(`API: http://localhost:${PORT}/api`);
      logger.info(`Metrics: http://localhost:${PORT}/metrics`);
      logger.info(`Health: http://localhost:${PORT}/health`);
      logger.info(`WebSocket: ws://localhost:${PORT}/ws`);
    });
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

/** Graceful shutdown handler - closes WebSocket and HTTP server cleanly */
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down...');
  if (wsGateway) {
    wsGateway.close();
  }
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down...');
  if (wsGateway) {
    wsGateway.close();
  }
  server.close(() => {
    logger.info('Server closed');
    process.exit(0);
  });
});

// Log uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled rejection');
});

start();
