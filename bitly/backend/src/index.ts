/**
 * Bitly URL Shortener - Main Server Entry Point
 *
 * This is the main application file that configures and starts the Express server.
 * It sets up middleware, routes, metrics, and handles graceful shutdown.
 */
import type { Server } from 'http';
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import pinoHttp from 'pino-http';

import { SERVER_CONFIG, SERVER_ID, SHUTDOWN_TIMEOUT_MS } from './config.js';
import { testConnection, closePool, isDatabaseConnected, getCircuitBreakerStatus } from './utils/database.js';
import { closeRedis, isRedisConnected } from './utils/cache.js';
import { connectQueue, closeQueue, isQueueConnected } from './utils/queue.js';
import {
  initKeyService,
  getLocalCacheCount,
  getKeyPoolStats,
  reclaimStaleKeys,
  startKeyReclaimer,
  stopKeyReclaimer,
} from './services/keyService.js';
import { waitForPendingClickDispatches } from './services/analyticsService.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { generalLimiter } from './middleware/rateLimit.js';
import logger from './utils/logger.js';
import {
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDuration,
  keyPoolAvailable,
  localKeyCacheCount,
} from './utils/metrics.js';

import authRoutes from './routes/auth.js';
import urlRoutes from './routes/urls.js';
import analyticsRoutes from './routes/analytics.js';
import adminRoutes from './routes/admin.js';
import redirectRoutes from './routes/redirect.js';

/** Express application instance */
const app = express();

// Pino HTTP logger middleware
app.use(
  pinoHttp({
    logger,
    customLogLevel: (req, res, err) => {
      if (res.statusCode >= 500 || err) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage: (req, res) => {
      return `${req.method} ${req.url} ${res.statusCode}`;
    },
    // Redact sensitive headers
    redact: ['req.headers.cookie', 'req.headers.authorization'],
  })
);

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable for development
  })
);

// CORS
app.use(
  cors({
    origin: SERVER_CONFIG.corsOrigin,
    credentials: true,
  })
);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Cookie parsing
app.use(cookieParser());

// Request metrics middleware
app.use((req: Request, res: Response, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const endpoint = req.route?.path || req.path;

    httpRequestsTotal.inc({
      method: req.method,
      endpoint,
      status: res.statusCode.toString(),
    });

    httpRequestDuration.observe(
      {
        method: req.method,
        endpoint,
      },
      duration
    );
  });

  next();
});

// Apply general rate limit to API routes (Redis-backed, shared by all instances).
// URL creation has its own stricter limiter inside the urls router.
app.use('/api', generalLimiter);

/**
 * Prometheus metrics endpoint.
 * Exposes application metrics for scraping by Prometheus.
 */
app.get('/metrics', async (req: Request, res: Response) => {
  localKeyCacheCount.set(getLocalCacheCount());
  try {
    // Update key pool metrics before scraping
    const keyStats = await getKeyPoolStats();
    keyPoolAvailable.set(keyStats.available);
  } catch (error) {
    // A database outage must not hide every other metric.
    logger.warn({ err: error }, 'Key pool stats unavailable for metrics scrape');
  }

  try {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (error) {
    logger.error({ err: error }, 'Failed to collect metrics');
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

/**
 * Basic health check endpoint.
 * Used by load balancers for simple availability checks.
 */
app.get('/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Detailed health check endpoint.
 * Returns status of all dependencies (database, cache, queue, circuit breakers).
 */
app.get('/health/detailed', async (req: Request, res: Response) => {
  const dbHealthy = await isDatabaseConnected();
  const redisHealthy = isRedisConnected();
  const queueHealthy = isQueueConnected();
  const circuitBreaker = getCircuitBreakerStatus();

  // Queue is optional - system is healthy even if queue is down (uses sync fallback)
  const status = dbHealthy && redisHealthy ? 'healthy' : 'degraded';
  const statusCode = status === 'healthy' ? 200 : 503;

  res.status(statusCode).json({
    status,
    timestamp: new Date().toISOString(),
    server_id: SERVER_ID,
    uptime: process.uptime(),
    dependencies: {
      database: {
        status: dbHealthy ? 'connected' : 'disconnected',
        circuit_breaker: circuitBreaker,
      },
      redis: {
        status: redisHealthy ? 'connected' : 'disconnected',
      },
      rabbitmq: {
        status: queueHealthy ? 'connected' : 'disconnected',
        note: queueHealthy ? 'async analytics enabled' : 'using sync fallback',
      },
    },
    key_pool: {
      local_cache: getLocalCacheCount(),
    },
  });
});

/**
 * Readiness check endpoint.
 * Used by Kubernetes to determine if the service is ready to receive traffic.
 */
app.get('/ready', async (req: Request, res: Response) => {
  const dbHealthy = await isDatabaseConnected();
  const redisHealthy = isRedisConnected();

  if (dbHealthy && redisHealthy) {
    res.json({ ready: true });
  } else {
    res.status(503).json({
      ready: false,
      issues: {
        database: !dbHealthy ? 'disconnected' : 'ok',
        redis: !redisHealthy ? 'disconnected' : 'ok',
      },
    });
  }
});

// API routes
// POST /api/v1/urls attaches its creation limiter, auth, and Idempotency-Key handling in
// the urls router itself: middleware registered after a router that already responded
// never runs.
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/urls', urlRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/admin', adminRoutes);

// Redirect route (must be last - catches /:shortCode)
app.use('/', redirectRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

/** HTTP server handle, set once listening. */
let server: Server | null = null;
let shuttingDown = false;

/**
 * Handles graceful shutdown of the server.
 * Stops accepting connections and lets in-flight requests finish, stops the key reaper,
 * waits for click events whose redirect was already served, then closes RabbitMQ,
 * PostgreSQL, and Redis. Forces exit if this takes longer than SHUTDOWN_TIMEOUT_MS.
 * @param signal - The signal that triggered the shutdown (SIGTERM or SIGINT)
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'Shutdown signal received, starting graceful shutdown');
  setTimeout(() => {
    logger.error({ timeout_ms: SHUTDOWN_TIMEOUT_MS }, 'Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  try {
    stopKeyReclaimer();

    if (server) {
      const httpServer = server;
      // close() stops new connections and resolves once in-flight requests complete
      // (Node >= 19 also closes idle keep-alive sockets as part of close()).
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }

    await waitForPendingClickDispatches(SHUTDOWN_TIMEOUT_MS / 2);
    await closeQueue();
    await closePool();
    await closeRedis();
    logger.info('Cleanup complete. Exiting.');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

/**
 * Initializes and starts the HTTP server.
 * Tests the database connection, repairs the key pool, initializes the key service,
 * and connects to RabbitMQ.
 */
async function start(): Promise<void> {
  try {
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database. Exiting.');
      process.exit(1);
    }

    // Release leases stranded by crashed instances before leasing our own batch.
    try {
      await reclaimStaleKeys();
    } catch (error) {
      logger.error({ err: error }, 'Startup key pool reclaim failed; continuing');
    }

    // Initialize key service
    await initKeyService();

    // Connect to RabbitMQ (optional - sync fallback until it is available; reconnects in background)
    const queueConnected = await connectQueue();
    if (!queueConnected) {
      logger.warn('RabbitMQ not available. Click events will be recorded synchronously.');
    }

    // Start listening
    server = app.listen(SERVER_CONFIG.port, SERVER_CONFIG.host, () => {
      logger.info(
        {
          port: SERVER_CONFIG.port,
          host: SERVER_CONFIG.host,
          base_url: SERVER_CONFIG.baseUrl,
          cors_origin: SERVER_CONFIG.corsOrigin,
          queue_enabled: queueConnected,
        },
        'Server started'
      );
    });

    startKeyReclaimer();
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

start();
