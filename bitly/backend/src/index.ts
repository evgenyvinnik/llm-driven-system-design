/**
 * Bitly URL Shortener - Main Server Entry Point
 *
 * This is the main application file that configures and starts the Express server.
 * It sets up middleware, routes, metrics, and handles graceful shutdown.
 */
import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import pinoHttp from 'pino-http';

import { SERVER_CONFIG, RATE_LIMIT_CONFIG } from './config.js';
import { testConnection, closePool, isDatabaseConnected, getCircuitBreakerStatus } from './utils/database.js';
import { closeRedis, isRedisConnected } from './utils/cache.js';
import { connectQueue, closeQueue, isQueueConnected } from './utils/queue.js';
import { initKeyService, getLocalCacheCount, getKeyPoolStats } from './services/keyService.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import logger from './utils/logger.js';
import {
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDuration,
  rateLimitHitsTotal,
  keyPoolAvailable,
  localKeyCacheCount,
} from './utils/metrics.js';
import { idempotencyMiddleware } from './utils/idempotency.js';

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

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.general.windowMs,
  max: RATE_LIMIT_CONFIG.general.max,
  message: { error: 'Too many requests, please try again later' },
  handler: (req, res) => {
    rateLimitHitsTotal.inc({ endpoint: req.path });
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});

const createUrlLimiter = rateLimit({
  windowMs: RATE_LIMIT_CONFIG.createUrl.windowMs,
  max: RATE_LIMIT_CONFIG.createUrl.max,
  message: { error: 'Too many URLs created, please try again later' },
  handler: (req, res) => {
    rateLimitHitsTotal.inc({ endpoint: 'create_url' });
    res.status(429).json({ error: 'Too many URLs created, please try again later' });
  },
});

// Apply general rate limit to API routes
app.use('/api', generalLimiter);

/**
 * Prometheus metrics endpoint.
 * Exposes application metrics for scraping by Prometheus.
 */
app.get('/metrics', async (req: Request, res: Response) => {
  try {
    // Update key pool metrics before scraping
    const keyStats = await getKeyPoolStats();
    keyPoolAvailable.set(keyStats.available);
    localKeyCacheCount.set(getLocalCacheCount());

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
    server_id: process.env.SERVER_ID || `server-${process.pid}`,
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
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/urls', urlRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/admin', adminRoutes);

// Apply stricter rate limit and idempotency to URL creation
app.post('/api/v1/urls', createUrlLimiter, idempotencyMiddleware);

// Redirect route (must be last - catches /:shortCode)
app.use('/', redirectRoutes);

// Error handling
app.use(notFoundHandler);
app.use(errorHandler);

/**
 * Handles graceful shutdown of the server.
 * Closes database, Redis, and RabbitMQ connections before exiting.
 * @param signal - The signal that triggered the shutdown (SIGTERM or SIGINT)
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received, starting graceful shutdown');

  try {
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

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

/**
 * Initializes and starts the HTTP server.
 * Tests database connection, initializes the key service, and connects to RabbitMQ.
 */
async function start(): Promise<void> {
  try {
    // Test database connection
    const dbConnected = await testConnection();
    if (!dbConnected) {
      logger.error('Failed to connect to database. Exiting.');
      process.exit(1);
    }

    // Initialize key service
    await initKeyService();

    // Connect to RabbitMQ (optional - will use sync fallback if unavailable)
    const queueConnected = await connectQueue();
    if (!queueConnected) {
      logger.warn('RabbitMQ not available. Click events will be recorded synchronously.');
    }

    // Start listening
    app.listen(SERVER_CONFIG.port, SERVER_CONFIG.host, () => {
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
  } catch (error) {
    logger.error({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

start();
