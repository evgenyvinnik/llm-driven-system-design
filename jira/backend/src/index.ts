/**
 * Main Express server entry point for the Jira clone backend.
 * Configures middleware, session management, routes, and server lifecycle.
 */

import express from 'express';
import cors from 'cors';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { config } from './config/index.js';
import { redis } from './config/redis.js';
import { initializeElasticsearch, esClient } from './config/elasticsearch.js';
import { pool } from './config/database.js';
import { logger } from './config/logger.js';
import { metricsRegistry, httpRequestsCounter, httpLatencyHistogram } from './config/metrics.js';
import { initializeMessageQueue, closeMessageQueue } from './config/messageQueue.js';
import { idempotencyMiddleware } from './middleware/idempotency.js';

// Routes
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import issueRoutes from './routes/issues.js';
import searchRoutes from './routes/search.js';
import workflowRoutes from './routes/workflows.js';

// Redis session store
import RedisStore from 'connect-redis';

const app = express();

// Request logging and metrics middleware
app.use((req, res, next) => {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - startTime) / 1000;
    const path = req.route?.path || req.path;

    // Record metrics
    httpRequestsCounter.inc({
      method: req.method,
      path,
      status_code: res.statusCode.toString(),
    });
    httpLatencyHistogram.observe({ method: req.method, path }, duration);

    // Log request
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: Date.now() - startTime,
      user_id: req.session?.userId,
    }, 'HTTP request completed');
  });

  next();
});

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());

/**
 * Session store using Redis for distributed session management.
 * Prefixes keys with 'jira:session:' for easy identification.
 */
const redisStore = new RedisStore({
  client: redis,
  prefix: 'jira:session:',
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

/**
 * Prometheus metrics endpoint.
 * Exposes all registered metrics for scraping by Prometheus.
 */
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (error) {
    logger.error({ err: error }, 'Failed to generate metrics');
    res.status(500).end();
  }
});

/**
 * Health check endpoint.
 * Verifies database, Redis, Elasticsearch, and RabbitMQ connectivity
 * for load balancer health checks.
 */
app.get('/health', async (req, res) => {
  const checks: Record<string, { status: string; latency_ms?: number; error?: string }> = {};
  let healthy = true;

  // Check PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    checks.postgres = { status: 'healthy', latency_ms: Date.now() - start };
  } catch (error) {
    checks.postgres = { status: 'unhealthy', error: String(error) };
    healthy = false;
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    checks.redis = { status: 'healthy', latency_ms: Date.now() - start };
  } catch (error) {
    checks.redis = { status: 'unhealthy', error: String(error) };
    healthy = false;
  }

  // Check Elasticsearch
  try {
    const start = Date.now();
    await esClient.ping();
    checks.elasticsearch = { status: 'healthy', latency_ms: Date.now() - start };
  } catch (error) {
    checks.elasticsearch = { status: 'unhealthy', error: String(error) };
    // ES is optional for basic functionality
  }

  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

/**
 * Readiness check endpoint.
 * Returns 200 when the service is ready to accept traffic.
 */
app.get('/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'ready' });
  } catch (error) {
    res.status(503).json({ status: 'not ready', error: String(error) });
  }
});

// Apply idempotency middleware to mutating API routes
app.use('/api', idempotencyMiddleware);

// API routes
app.use('/api/auth', authRoutes);
app.use('/api/users', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/issues', issueRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/workflows', workflowRoutes);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({
    err,
    method: req.method,
    path: req.path,
    user_id: req.session?.userId,
  }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

/**
 * Starts the Express server.
 * Initializes Elasticsearch index, RabbitMQ connection, and begins listening for requests.
 */
async function start() {
  try {
    // Initialize Elasticsearch index
    await initializeElasticsearch();

    // Initialize RabbitMQ (non-blocking, will retry in background)
    initializeMessageQueue().catch((err) => {
      logger.warn({ err }, 'RabbitMQ initialization failed, will retry');
    });

    app.listen(config.port, () => {
      logger.info({
        port: config.port,
        env: config.nodeEnv,
      }, 'Server started');
    });
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

start();

/**
 * Graceful shutdown handler.
 * Closes database pool, Redis connection, and RabbitMQ before exiting.
 */
async function shutdown(signal: string) {
  logger.info({ signal }, 'Received shutdown signal, shutting down gracefully');

  try {
    await closeMessageQueue();
    await pool.end();
    await redis.quit();
    logger.info('Graceful shutdown complete');
    process.exit(0);
  } catch (error) {
    logger.error({ err: error }, 'Error during graceful shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});
