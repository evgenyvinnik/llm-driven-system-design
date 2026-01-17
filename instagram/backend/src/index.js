import express from 'express';
import session from 'express-session';
import RedisStore from 'connect-redis';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';
import config from './config/index.js';
import redis from './services/redis.js';
import { ensureBucket } from './services/storage.js';
import logger, { logRequest, logError } from './services/logger.js';
import { register, metricsMiddleware, httpRequestDuration } from './services/metrics.js';
import { attachUserContext } from './middleware/auth.js';
import { generalRateLimiter } from './services/rateLimiter.js';
import pool from './services/db.js';

// Import routes
import authRoutes from './routes/auth.js';
import postRoutes from './routes/posts.js';
import commentRoutes from './routes/comments.js';
import userRoutes from './routes/users.js';
import feedRoutes from './routes/feed.js';
import storyRoutes from './routes/stories.js';

const app = express();

// Trust proxy for rate limiting behind load balancer
app.set('trust proxy', 1);

// CORS configuration
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    credentials: true,
  })
);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request ID / Trace ID middleware
app.use((req, res, next) => {
  req.traceId = req.headers['x-trace-id'] || uuidv4();
  res.setHeader('x-trace-id', req.traceId);
  next();
});

// Request timing and logging middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    logRequest(req, res, duration);
  });

  next();
});

// Prometheus metrics middleware
app.use(metricsMiddleware);

// Session configuration with Redis store
const redisStore = new RedisStore({
  client: redis,
  prefix: 'sess:',
});

app.use(
  session({
    store: redisStore,
    secret: config.session.secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: config.nodeEnv === 'production',
      httpOnly: true,
      maxAge: config.session.maxAge,
      sameSite: 'lax',
    },
  })
);

// Attach user context for logging
app.use(attachUserContext);

// General rate limiter (applies to all routes)
app.use('/api/', generalRateLimiter);

// ============================================
// Health and Metrics Endpoints
// ============================================

/**
 * Prometheus metrics endpoint
 * Exposes all collected metrics in Prometheus format
 */
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (error) {
    logError(error, { endpoint: '/metrics' });
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

/**
 * Simple health check - returns 200 if server is running
 */
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Comprehensive health check - checks all dependencies
 * Returns detailed status of each component
 */
app.get('/api/health/detailed', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    components: {},
  };

  // Check PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    health.components.database = {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    health.status = 'degraded';
    health.components.database = {
      status: 'error',
      error: error.message,
    };
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    health.components.redis = {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    health.status = 'degraded';
    health.components.redis = {
      status: 'error',
      error: error.message,
    };
  }

  // Check MinIO - just check if bucket exists
  try {
    const start = Date.now();
    await ensureBucket();
    health.components.storage = {
      status: 'ok',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    health.status = 'degraded';
    health.components.storage = {
      status: 'error',
      error: error.message,
    };
  }

  // Memory usage
  const memUsage = process.memoryUsage();
  health.memory = {
    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
    rssMB: Math.round(memUsage.rss / 1024 / 1024),
  };

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

/**
 * Liveness probe - returns 200 if process is alive
 */
app.get('/api/health/live', (req, res) => {
  res.json({ status: 'alive' });
});

/**
 * Readiness probe - returns 200 if ready to accept traffic
 */
app.get('/api/health/ready', async (req, res) => {
  try {
    // Quick checks that we can handle traffic
    await Promise.all([pool.query('SELECT 1'), redis.ping()]);
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not_ready', error: error.message });
  }
});

// ============================================
// API Routes
// ============================================

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/posts', postRoutes);
app.use('/api/v1', commentRoutes);
app.use('/api/v1/users', userRoutes);
app.use('/api/v1/feed', feedRoutes);
app.use('/api/v1/stories', storyRoutes);

// ============================================
// Error Handling
// ============================================

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, req, res, next) => {
  logError(err, {
    requestId: req.traceId,
    method: req.method,
    path: req.path,
    userId: req.session?.userId,
  });

  // Handle known error types
  if (err.statusCode) {
    return res.status(err.statusCode).json({ error: err.message });
  }

  // Handle rate limit errors
  if (err.name === 'RateLimitError') {
    return res.status(429).json({ error: 'Too many requests' });
  }

  // Default to 500
  res.status(500).json({ error: 'Internal server error' });
});

// ============================================
// Server Startup
// ============================================

const startServer = async () => {
  try {
    // Ensure MinIO bucket exists
    await ensureBucket();

    // Start the server
    app.listen(config.port, () => {
      logger.info({
        port: config.port,
        env: config.nodeEnv,
        pid: process.pid,
      }, `Instagram API server running on port ${config.port}`);
    });
  } catch (error) {
    logError(error, { context: 'startup' });
    process.exit(1);
  }
};

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info({ signal }, `Received ${signal}, starting graceful shutdown`);

  // Close database pool
  try {
    await pool.end();
    logger.info('Database connections closed');
  } catch (err) {
    logError(err, { context: 'shutdown', component: 'database' });
  }

  // Close Redis connection
  try {
    await redis.quit();
    logger.info('Redis connection closed');
  } catch (err) {
    logError(err, { context: 'shutdown', component: 'redis' });
  }

  process.exit(0);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

startServer();
