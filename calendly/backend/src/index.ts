import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import session from 'express-session';
import * as pinoHttpModule from 'pino-http';
import { IncomingMessage, ServerResponse } from 'http';
import { testDatabaseConnection, testRedisConnection, redis, pool } from './db/index.js';

// Handle ESM/CJS default export for pino-http
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pinoHttp = (pinoHttpModule as any).default || pinoHttpModule;

// Shared modules
import { logger } from './shared/logger.js';
import { register, httpRequestDuration, httpRequestsTotal, dbPoolGauge } from './shared/metrics.js';
import { performHealthCheck, performDetailedHealthCheck, isReady } from './shared/health.js';
import { APP_CONFIG } from './shared/config.js';

// Import routes
import authRoutes from './routes/auth.js';
import meetingTypesRoutes from './routes/meetingTypes.js';
import availabilityRoutes from './routes/availability.js';
import bookingsRoutes from './routes/bookings.js';
import adminRoutes from './routes/admin.js';

// Redis session store
import RedisStore from 'connect-redis';

/**
 * Express application for the Calendly API server.
 * Provides RESTful endpoints for scheduling and booking management.
 */
const app = express();

/** Server port from environment or default to 3001 */
const PORT = APP_CONFIG.PORT;

// ============================================================================
// MIDDLEWARE SETUP
// ============================================================================

// Structured JSON logging for all HTTP requests
app.use(pinoHttp({
  logger,
  genReqId: (req: IncomingMessage) => (req.headers['x-request-id'] as string) || crypto.randomUUID(),
  customProps: (req: IncomingMessage) => ({
    userId: (req as unknown as Request).session?.userId,
  }),
  customLogLevel: (_req: IncomingMessage, res: ServerResponse, err: Error | undefined) => {
    if (res.statusCode >= 500 || err) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req: IncomingMessage, res: ServerResponse) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage: (req: IncomingMessage, res: ServerResponse) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
}));

// CORS configuration for frontend requests
app.use(cors({
  origin: APP_CONFIG.FRONTEND_URL,
  credentials: true,
}));

// Parse JSON request bodies
app.use(express.json());

/**
 * Redis-backed session store.
 * Sessions are prefixed with 'calendly:session:' in Redis.
 */
const redisStore = new RedisStore({
  client: redis,
  prefix: 'calendly:session:',
});

/**
 * Session middleware configuration.
 * Uses Redis for session storage with secure cookie settings.
 */
app.use(session({
  store: redisStore,
  secret: APP_CONFIG.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: APP_CONFIG.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    sameSite: 'lax',
  },
}));

// ============================================================================
// METRICS MIDDLEWARE
// ============================================================================

/**
 * HTTP request metrics middleware.
 * Records duration and count for all requests.
 */
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const route = req.route?.path || req.path || 'unknown';
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };

    httpRequestDuration.observe(labels, duration);
    httpRequestsTotal.inc(labels);
  });

  next();
});

// ============================================================================
// HEALTH CHECK ENDPOINTS
// ============================================================================

/**
 * Basic health check endpoint for load balancers.
 * Returns 200 if healthy, 503 if unhealthy.
 */
app.get('/health', async (_req, res) => {
  const health = await performHealthCheck();
  res.status(health.status === 'unhealthy' ? 503 : 200).json(health);
});

/**
 * Detailed health check endpoint for debugging.
 * Returns comprehensive component status.
 */
app.get('/health/detailed', async (_req, res) => {
  const health = await performDetailedHealthCheck();
  res.status(health.status === 'unhealthy' ? 503 : 200).json(health);
});

/**
 * Kubernetes liveness probe.
 * Returns 200 if process is running.
 */
app.get('/health/live', (_req, res) => {
  res.status(200).json({ status: 'alive' });
});

/**
 * Kubernetes readiness probe.
 * Returns 200 if ready to accept traffic.
 */
app.get('/health/ready', async (_req, res) => {
  const ready = await isReady();
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready' });
});

// ============================================================================
// PROMETHEUS METRICS ENDPOINT
// ============================================================================

/**
 * Prometheus metrics endpoint.
 * Exposes all application metrics for scraping.
 */
app.get('/metrics', async (_req, res) => {
  try {
    // Update database pool metrics
    dbPoolGauge.set({ state: 'total' }, pool.totalCount);
    dbPoolGauge.set({ state: 'idle' }, pool.idleCount);
    dbPoolGauge.set({ state: 'waiting' }, pool.waitingCount);

    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logger.error({ error }, 'Error generating metrics');
    res.status(500).end();
  }
});

// ============================================================================
// API ROUTES
// ============================================================================

// Mount API route handlers
app.use('/api/auth', authRoutes);
app.use('/api/meeting-types', meetingTypesRoutes);
app.use('/api/availability', availabilityRoutes);
app.use('/api/bookings', bookingsRoutes);
app.use('/api/admin', adminRoutes);

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Global error handler for unhandled errors.
 * Logs the error and returns a generic 500 response.
 */
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({
    err,
    method: req.method,
    url: req.url,
    userId: req.session?.userId,
  }, 'Unhandled error');

  res.status(500).json({
    success: false,
    error: 'Internal server error',
  });
});

/**
 * 404 handler for unmatched routes.
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
  });
});

// ============================================================================
// SERVER STARTUP
// ============================================================================

/**
 * Initializes and starts the API server.
 * Tests database and Redis connections before listening.
 */
async function start() {
  logger.info({ port: PORT }, 'Starting Calendly API server');

  // Test connections
  const dbConnected = await testDatabaseConnection();
  const redisConnected = await testRedisConnection();

  if (!dbConnected) {
    logger.warn('Database connection failed. Some features may not work.');
  }

  if (!redisConnected) {
    logger.warn('Redis connection failed. Sessions and caching may not work.');
  }

  app.listen(PORT, () => {
    logger.info({
      port: PORT,
      healthEndpoint: `http://localhost:${PORT}/health`,
      metricsEndpoint: `http://localhost:${PORT}/metrics`,
    }, 'Calendly API server started');
  });
}

start().catch((error) => {
  logger.fatal({ error }, 'Failed to start server');
  process.exit(1);
});

export default app;
