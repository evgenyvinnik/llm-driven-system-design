/**
 * Main entry point for the LinkedIn clone backend server.
 * Configures Express with middleware, session handling, and route mounting.
 * Initializes Elasticsearch indices, RabbitMQ, and starts the HTTP server.
 *
 * @module index
 */
import express from 'express';
import cors from 'cors';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';

import { redis } from './utils/redis.js';
import { initializeElasticsearch } from './utils/elasticsearch.js';
import { connectRabbitMQ, isRabbitMQConnected, closeRabbitMQ } from './utils/rabbitmq.js';
import { logger } from './utils/logger.js';
import { metricsMiddleware, getMetrics, getMetricsContentType, updateQueueMetrics } from './utils/metrics.js';
import { pool } from './utils/db.js';
import { attachUserContext } from './middleware/auth.js';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import connectionRoutes from './routes/connections.js';
import feedRoutes from './routes/feed.js';
import jobRoutes from './routes/jobs.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001');

// Trust proxy for accurate client IP (needed for rate limiting)
app.set('trust proxy', 1);

// Middleware
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

// Add trace ID to each request
app.use((req, res, next) => {
  const traceId = (req.headers['x-trace-id'] as string) || crypto.randomUUID();
  const spanId = crypto.randomUUID();

  // Store trace context on request
  (req as express.Request & { traceContext: { traceId: string; spanId: string } }).traceContext = {
    traceId,
    spanId,
  };

  // Set response header for correlation
  res.setHeader('X-Trace-Id', traceId);
  next();
});

// Metrics middleware (before routes)
app.use(metricsMiddleware);

// Session configuration using Redis
// Using a simple in-memory store for development (Redis session store would be used in production)
app.use(session({
  secret: process.env.SESSION_SECRET || 'linkedin-dev-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    sameSite: 'strict',
  },
}));

// Attach user context for logging
app.use(attachUserContext);

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const traceContext = (req as express.Request & { traceContext: { traceId: string; spanId: string } }).traceContext;

    logger.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration,
      userId: req.session?.userId,
      traceId: traceContext?.traceId,
      ip: req.ip,
    }, `${req.method} ${req.path}`);
  });

  next();
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    // Update queue metrics before serving
    await updateQueueMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.end(await getMetrics());
  } catch (error) {
    logger.error({ error }, 'Failed to get metrics');
    res.status(500).json({ error: 'Failed to get metrics' });
  }
});

// Enhanced health check
app.get('/health', async (req, res) => {
  const checks: Record<string, { status: string; latency?: number; error?: string }> = {};

  // Check PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    checks.postgres = { status: 'healthy', latency: Date.now() - start };
  } catch (error) {
    checks.postgres = { status: 'unhealthy', error: (error as Error).message };
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    checks.redis = { status: 'healthy', latency: Date.now() - start };
  } catch (error) {
    checks.redis = { status: 'unhealthy', error: (error as Error).message };
  }

  // Check RabbitMQ
  checks.rabbitmq = {
    status: isRabbitMQConnected() ? 'healthy' : 'unhealthy',
  };

  // Overall status
  const allHealthy = Object.values(checks).every(c => c.status === 'healthy');

  res.status(allHealthy ? 200 : 503).json({
    status: allHealthy ? 'healthy' : 'degraded',
    port: PORT,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks,
  });
});

// Liveness probe (for Kubernetes)
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok' });
});

// Readiness probe (for Kubernetes)
app.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: (error as Error).message });
  }
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/feed', feedRoutes);
app.use('/api/jobs', jobRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const traceContext = (req as express.Request & { traceContext: { traceId: string; spanId: string } }).traceContext;

  logger.error({
    error: {
      name: err.name,
      message: err.message,
      stack: err.stack,
    },
    method: req.method,
    path: req.path,
    userId: req.session?.userId,
    traceId: traceContext?.traceId,
  }, 'Unhandled error');

  res.status(500).json({
    error: 'Internal server error',
    traceId: traceContext?.traceId,
  });
});

/**
 * Initializes the server by setting up Elasticsearch indices,
 * RabbitMQ connection, and starting the Express HTTP listener.
 */
async function start() {
  try {
    logger.info({ port: PORT }, 'Starting LinkedIn API server...');

    // Initialize Elasticsearch indices
    await initializeElasticsearch();
    logger.info('Elasticsearch initialized');

    // Connect to RabbitMQ (optional - server starts even if RabbitMQ is unavailable)
    try {
      await connectRabbitMQ();
      logger.info('RabbitMQ connected');
    } catch (error) {
      logger.warn({ error }, 'RabbitMQ connection failed - async features disabled');
    }

    // Start metrics update interval
    setInterval(async () => {
      try {
        await updateQueueMetrics();
      } catch (error) {
        logger.error({ error }, 'Failed to update queue metrics');
      }
    }, 15000); // Every 15 seconds

    app.listen(PORT, () => {
      logger.info({
        port: PORT,
        healthCheck: `http://localhost:${PORT}/health`,
        metrics: `http://localhost:${PORT}/metrics`,
      }, `LinkedIn API server running on port ${PORT}`);
    });

    // Graceful shutdown
    process.on('SIGTERM', async () => {
      logger.info('SIGTERM received, shutting down gracefully...');
      await closeRabbitMQ();
      await pool.end();
      redis.disconnect();
      process.exit(0);
    });

    process.on('SIGINT', async () => {
      logger.info('SIGINT received, shutting down gracefully...');
      await closeRabbitMQ();
      await pool.end();
      redis.disconnect();
      process.exit(0);
    });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    process.exit(1);
  }
}

start();

export default app;
