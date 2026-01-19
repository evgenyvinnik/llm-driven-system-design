import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';

import { pool } from './utils/db.js';
import { redis } from './utils/redis.js';
import { elasticsearch, initElasticsearch } from './utils/elasticsearch.js';
import { connectQueue, closeQueue, isQueueConnected } from './utils/queue.js';
import { logger, logRequest } from './utils/logger.js';
import {
  getMetrics,
  getContentType,
  recordHttpRequest,
  updateDbPoolMetrics,
} from './utils/metrics.js';
import { getCircuitBreakerStatus } from './utils/circuitBreaker.js';

import authRoutes from './routes/auth.js';
import businessRoutes from './routes/businesses.js';
import reviewRoutes from './routes/reviews.js';
import searchRoutes from './routes/search.js';
import categoryRoutes from './routes/categories.js';
import userRoutes from './routes/users.js';
import adminRoutes from './routes/admin.js';
import photosRoutes from './routes/photos.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  credentials: true
}));

// Global rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// Parsing middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Request ID middleware
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || uuidv4();
  res.set('X-Request-ID', req.requestId);
  next();
});

// Request timing and metrics middleware
app.use((req, res, next) => {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const end = process.hrtime.bigint();
    const durationNs = Number(end - start);
    const durationMs = durationNs / 1e6;
    const durationSeconds = durationNs / 1e9;

    // Record metrics
    recordHttpRequest(req.method, req.path, res.statusCode, durationSeconds);

    // Log request
    logRequest(req, res, durationMs, {
      requestId: req.requestId,
    });
  });

  next();
});

// Static files for uploaded images
app.use('/uploads', express.static('uploads'));

// ============================================================================
// Health Check Endpoint
// ============================================================================
app.get('/health', async (req, res) => {
  const checks = {
    postgresql: { status: 'unknown', latency: null },
    redis: { status: 'unknown', latency: null },
    elasticsearch: { status: 'unknown', latency: null },
    rabbitmq: { status: 'unknown' },
  };

  let overallStatus = 'healthy';

  // Check PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    checks.postgresql = {
      status: 'connected',
      latency: Date.now() - start,
    };
  } catch (error) {
    checks.postgresql = {
      status: 'disconnected',
      error: error.message,
    };
    overallStatus = 'unhealthy';
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    checks.redis = {
      status: 'connected',
      latency: Date.now() - start,
    };
  } catch (error) {
    checks.redis = {
      status: 'disconnected',
      error: error.message,
    };
    overallStatus = 'unhealthy';
  }

  // Check Elasticsearch
  try {
    const start = Date.now();
    await elasticsearch.ping();
    checks.elasticsearch = {
      status: 'connected',
      latency: Date.now() - start,
    };
  } catch (error) {
    checks.elasticsearch = {
      status: 'disconnected',
      error: error.message,
    };
    overallStatus = 'degraded'; // ES is not critical
  }

  // Check RabbitMQ
  checks.rabbitmq = {
    status: isQueueConnected() ? 'connected' : 'disconnected',
  };
  if (!isQueueConnected()) {
    overallStatus = 'degraded'; // Queue is not critical for reads
  }

  // Get circuit breaker status
  const circuitBreakers = getCircuitBreakerStatus();

  // Get database pool metrics
  const dbPool = {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };

  const healthResponse = {
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: checks,
    circuitBreakers,
    dbPool,
    version: process.env.npm_package_version || '1.0.0',
  };

  const statusCode = overallStatus === 'healthy' ? 200 : overallStatus === 'degraded' ? 200 : 503;
  res.status(statusCode).json(healthResponse);
});

// ============================================================================
// Prometheus Metrics Endpoint
// ============================================================================
app.get('/metrics', async (req, res) => {
  try {
    // Update database pool metrics before returning
    updateDbPoolMetrics(pool);

    res.set('Content-Type', getContentType());
    res.end(await getMetrics());
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get metrics');
    res.status(500).end();
  }
});

// ============================================================================
// Readiness probe (for Kubernetes)
// ============================================================================
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ ready: true });
  } catch (error) {
    res.status(503).json({ ready: false, error: error.message });
  }
});

// ============================================================================
// Liveness probe (for Kubernetes)
// ============================================================================
app.get('/live', (req, res) => {
  res.json({ alive: true, uptime: process.uptime() });
});

// ============================================================================
// API Routes
// ============================================================================
app.use('/api/auth', authRoutes);
app.use('/api/businesses', businessRoutes);
app.use('/api/reviews', reviewRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/users', userRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/photos', photosRoutes);

// ============================================================================
// Error handling middleware
// ============================================================================
app.use((err, req, res, next) => {
  const errorId = uuidv4();

  logger.error({
    errorId,
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    requestId: req.requestId,
    userId: req.user?.id,
  }, 'Unhandled error');

  res.status(err.status || 500).json({
    error: {
      message: process.env.NODE_ENV === 'production'
        ? 'Internal Server Error'
        : err.message,
      errorId,
      ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
    }
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: { message: 'Not Found' } });
});

// ============================================================================
// Initialize services and start server
// ============================================================================
async function start() {
  try {
    // Test database connection
    await pool.query('SELECT NOW()');
    logger.info({ component: 'database' }, 'PostgreSQL connected');

    // Test Redis connection
    await redis.ping();
    logger.info({ component: 'cache' }, 'Redis connected');

    // Initialize Elasticsearch indices
    await initElasticsearch();
    logger.info({ component: 'search' }, 'Elasticsearch initialized');

    // Connect to RabbitMQ for async processing
    try {
      await connectQueue();
      logger.info({ component: 'queue' }, 'RabbitMQ connected');
    } catch (error) {
      // Queue is not critical for server startup - log warning and continue
      logger.warn({ component: 'queue', error: error.message }, 'RabbitMQ not available, async indexing disabled');
    }

    app.listen(PORT, () => {
      logger.info({
        port: PORT,
        nodeEnv: process.env.NODE_ENV || 'development',
      }, 'Server started');
      logger.info({ url: `http://localhost:${PORT}/health` }, 'Health check available');
      logger.info({ url: `http://localhost:${PORT}/metrics` }, 'Prometheus metrics available');
    });
  } catch (error) {
    logger.fatal({ error: error.message }, 'Failed to start server');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await closeQueue();
  await pool.end();
  await redis.quit();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  await closeQueue();
  await pool.end();
  await redis.quit();
  process.exit(0);
});

start();
