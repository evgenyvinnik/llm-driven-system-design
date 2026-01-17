/**
 * Find My Network Backend Server
 *
 * Main entry point for the Express server that powers the AirTag-like tracking system.
 * Configures middleware, session management, and API routes for:
 * - User authentication and registration
 * - Device management and tracking
 * - Location reporting and retrieval
 * - Lost mode functionality
 * - Anti-stalking protection
 * - Admin dashboard
 *
 * OBSERVABILITY IMPROVEMENTS:
 * - Structured logging with Pino (JSON format for log aggregation)
 * - Prometheus metrics for monitoring and alerting
 * - Comprehensive health checks for container orchestration
 *
 * RELIABILITY IMPROVEMENTS:
 * - Redis caching for location queries (cache-aside pattern)
 * - Idempotency for location report submissions
 * - Rate limiting to prevent abuse and ensure fair usage
 */

import express from 'express';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import redis from './db/redis.js';

// Shared modules for observability and reliability
import {
  logger,
  httpLogger,
  metricsMiddleware,
  metricsHandler,
  shallowHealthCheck,
  deepHealthCheck,
  generalLimiter,
  authLimiter,
  locationReportLimiter,
  locationQueryLimiter,
  deviceRegistrationLimiter,
  adminLimiter,
} from './shared/index.js';

// Routes
import authRoutes from './routes/auth.js';
import deviceRoutes from './routes/devices.js';
import locationRoutes from './routes/locations.js';
import lostModeRoutes from './routes/lostMode.js';
import notificationRoutes from './routes/notifications.js';
import antiStalkingRoutes from './routes/antiStalking.js';
import adminRoutes from './routes/admin.js';

const app = express();

/** Server port, configurable via PORT environment variable */
const PORT = parseInt(process.env.PORT || '3000');

// ===== OBSERVABILITY MIDDLEWARE =====

// Structured HTTP request logging (before other middleware)
app.use(httpLogger);

// Prometheus metrics collection
app.use(metricsMiddleware);

// ===== CORE MIDDLEWARE =====

app.use(
  cors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json());

// Session configuration
const redisStore = new RedisStore({
  client: redis,
  prefix: 'findmy:session:',
});

app.use(
  session({
    store: redisStore,
    secret: process.env.SESSION_SECRET || 'findmy-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// ===== HEALTH CHECK ENDPOINTS =====
// These should NOT be rate limited or require authentication

/**
 * Shallow health check (liveness probe)
 * Use for: Kubernetes liveness probe, basic uptime monitoring
 * Returns 200 if the process is running
 */
app.get('/health', shallowHealthCheck);
app.get('/health/live', shallowHealthCheck);

/**
 * Deep health check (readiness probe)
 * Use for: Kubernetes readiness probe, load balancer health
 * Checks PostgreSQL and Redis connectivity
 * Returns 200 (healthy/degraded) or 503 (unhealthy)
 */
app.get('/health/ready', deepHealthCheck);

/**
 * Prometheus metrics endpoint
 * Use for: Prometheus scraping, Grafana dashboards
 * Returns metrics in Prometheus text format
 */
app.get('/metrics', metricsHandler);

// ===== API ROUTES WITH RATE LIMITING =====

/**
 * Authentication routes
 * Low rate limit (10/min) to prevent brute force attacks
 */
app.use('/api/auth', authLimiter, authRoutes);

/**
 * Device routes
 * Registration has lower limit; queries use general limit
 */
app.use('/api/devices', deviceRegistrationLimiter, deviceRoutes);

/**
 * Location routes
 * Split rate limiting:
 * - POST /report: High limit (100/min) for crowd-sourced ingestion
 * - GET queries: Medium limit (60/min) for user queries
 */
app.use('/api/locations', (req, res, next) => {
  // Apply different rate limits based on request type
  if (req.method === 'POST' && req.path === '/report') {
    return locationReportLimiter(req, res, next);
  }
  return locationQueryLimiter(req, res, next);
}, locationRoutes);

/**
 * Lost mode routes
 * General rate limit - toggle operations are infrequent
 */
app.use('/api/lost-mode', generalLimiter, lostModeRoutes);

/**
 * Notification routes
 * General rate limit
 */
app.use('/api/notifications', generalLimiter, notificationRoutes);

/**
 * Anti-stalking routes
 * General rate limit
 */
app.use('/api/anti-stalking', generalLimiter, antiStalkingRoutes);

/**
 * Admin routes
 * Stricter rate limit (20/min) for sensitive operations
 */
app.use('/api/admin', adminLimiter, adminRoutes);

// ===== ERROR HANDLING =====

/**
 * Global error handler
 * Logs errors with structured format for debugging
 * Returns generic error to clients (security best practice)
 */
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    next: express.NextFunction
  ) => {
    // Use structured logging for errors
    logger.error(
      {
        error: {
          message: err.message,
          stack: err.stack,
          name: err.name,
        },
        request: {
          method: req.method,
          url: req.url,
          ip: req.ip,
        },
      },
      'Unhandled error'
    );
    res.status(500).json({ error: 'Internal server error' });
  }
);

/**
 * 404 handler
 * Returns JSON error for consistency with API responses
 */
app.use((req, res) => {
  logger.warn({ method: req.method, url: req.url }, 'Route not found');
  res.status(404).json({ error: 'Not found' });
});

// ===== SERVER STARTUP =====

app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      nodeEnv: process.env.NODE_ENV || 'development',
    },
    'Find My Network server started'
  );
  logger.info({ url: `http://localhost:${PORT}/health` }, 'Health check available');
  logger.info({ url: `http://localhost:${PORT}/metrics` }, 'Prometheus metrics available');
});

export default app;
