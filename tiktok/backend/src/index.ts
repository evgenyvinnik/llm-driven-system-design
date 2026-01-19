import express from 'express';
import cors from 'cors';
import session from 'express-session';
import RedisStore from 'connect-redis';
import dotenv from 'dotenv';

import { connectRedis, getRedis } from './redis.js';
import { query } from './db.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import videoRoutes from './routes/videos.js';
import commentRoutes from './routes/comments.js';
import feedRoutes from './routes/feed.js';

// Shared modules
import logger, { requestLogger, createLogger } from './shared/logger.js';
import { getMetrics, getContentType, metricsMiddleware } from './shared/metrics.js';
import { createRateLimiters } from './shared/rateLimiter.js';
import { getAllCircuitBreakerStats } from './shared/circuitBreaker.js';
import { ensureRole } from './middleware/auth.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const appLogger = createLogger('app');

// Trust proxy for proper IP detection behind load balancer
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// Request logging middleware
app.use(requestLogger);

// Prometheus metrics middleware
app.use(metricsMiddleware);

// Session setup with Redis
let rateLimiters = null;

async function setupSession() {
  const redisClient = await connectRedis();

  const redisStore = new RedisStore({
    client: redisClient,
    prefix: 'tiktok:session:',
  });

  app.use(session({
    store: redisStore,
    secret: process.env.SESSION_SECRET || 'tiktok-dev-secret-change-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      sameSite: 'lax',
    },
  }));

  // Ensure role is set for all sessions
  app.use(ensureRole);

  // Initialize rate limiters with Redis client
  rateLimiters = createRateLimiters(redisClient);

  return redisClient;
}

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', getContentType());
    res.end(await getMetrics());
  } catch (error) {
    appLogger.error({ error: error.message }, 'Failed to get metrics');
    res.status(500).end('Error collecting metrics');
  }
});

// Enhanced health check endpoint
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || '1.0.0',
    checks: {},
  };

  // Check database connection
  try {
    const dbStart = Date.now();
    await query('SELECT 1');
    health.checks.database = {
      status: 'healthy',
      latencyMs: Date.now() - dbStart,
    };
  } catch (error) {
    health.checks.database = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check Redis connection
  try {
    const redis = getRedis();
    const redisStart = Date.now();
    await redis.ping();
    health.checks.redis = {
      status: 'healthy',
      latencyMs: Date.now() - redisStart,
    };
  } catch (error) {
    health.checks.redis = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check circuit breaker states
  health.checks.circuitBreakers = getAllCircuitBreakerStats();

  // Memory usage
  const memUsage = process.memoryUsage();
  health.memory = {
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
    rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
  };

  health.responseTimeMs = Date.now() - startTime;

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Liveness probe (for Kubernetes)
app.get('/health/live', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

// Readiness probe (for Kubernetes)
app.get('/health/ready', async (req, res) => {
  try {
    await query('SELECT 1');
    const redis = getRedis();
    await redis.ping();
    res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({
      status: 'not ready',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Rate limiters middleware getter
export const getRateLimiters = () => rateLimiters;

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/videos', videoRoutes);
app.use('/api/comments', commentRoutes);
app.use('/api/feed', feedRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler with structured logging
app.use((err, req, res, next) => {
  const requestId = req.requestId || 'unknown';

  // Log error with context
  appLogger.error({
    err: {
      message: err.message,
      stack: err.stack,
      name: err.name,
    },
    requestId,
    method: req.method,
    url: req.url,
    userId: req.session?.userId,
  }, 'Unhandled error');

  // Don't expose internal errors in production
  const message = process.env.NODE_ENV === 'production'
    ? 'Internal server error'
    : err.message;

  res.status(err.status || 500).json({
    error: message,
    requestId,
  });
});

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  appLogger.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

  // Stop accepting new connections
  server.close(() => {
    appLogger.info('HTTP server closed');
  });

  // Close Redis connection
  try {
    const redis = getRedis();
    await redis.quit();
    appLogger.info('Redis connection closed');
  } catch (error) {
    appLogger.error({ error: error.message }, 'Error closing Redis connection');
  }

  // Exit after timeout
  setTimeout(() => {
    appLogger.warn('Forced shutdown after timeout');
    process.exit(1);
  }, 10000);

  process.exit(0);
};

let server;

// Start server
async function start() {
  try {
    await setupSession();
    appLogger.info('Session store connected');

    server = app.listen(PORT, () => {
      appLogger.info({
        port: PORT,
        env: process.env.NODE_ENV || 'development',
      }, 'TikTok API server started');
      console.log(`TikTok API server running on port ${PORT}`);
      console.log(`Health check: http://localhost:${PORT}/health`);
      console.log(`Metrics: http://localhost:${PORT}/metrics`);
    });

    // Handle graceful shutdown
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  } catch (error) {
    appLogger.error({ error: error.message }, 'Failed to start server');
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

export { app, getRateLimiters as rateLimiters };
