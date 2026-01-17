import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';

// Load environment variables first
dotenv.config();

// Import shared modules
import logger, { createRequestLogger } from './shared/logger.js';
import {
  metricsMiddleware,
  getMetrics,
  getMetricsContentType,
  dbConnectionPoolSize,
  redisMemoryBytes,
} from './shared/metrics.js';

// Import routes
import paymentIntentsRouter from './routes/paymentIntents.js';
import customersRouter from './routes/customers.js';
import paymentMethodsRouter from './routes/paymentMethods.js';
import refundsRouter from './routes/refunds.js';
import webhooksRouter from './routes/webhooks.js';
import merchantsRouter from './routes/merchants.js';
import balanceRouter from './routes/balance.js';
import chargesRouter from './routes/charges.js';

// Import services
import { startWebhookWorker } from './services/webhooks.js';
import redis from './db/redis.js';
import pool from './db/pool.js';

const app = express();
const PORT = process.env.PORT || 3001;

// ========================
// Middleware Setup
// ========================

app.use(
  cors({
    origin: ['http://localhost:5173', 'http://localhost:3000'],
    credentials: true,
  })
);

app.use(express.json());

// Prometheus metrics middleware - collect request metrics
app.use(metricsMiddleware);

// Request logging middleware with structured logging
app.use((req, res, next) => {
  const startTime = process.hrtime();
  req.logger = createRequestLogger(req);

  // Log request received
  req.logger.debug({
    event: 'request_received',
    method: req.method,
    path: req.path,
    query: req.query,
  });

  // Log response when finished
  res.on('finish', () => {
    const [seconds, nanoseconds] = process.hrtime(startTime);
    const durationMs = (seconds * 1000 + nanoseconds / 1e6).toFixed(2);

    const logData = {
      event: 'request_completed',
      method: req.method,
      path: req.path,
      status_code: res.statusCode,
      duration_ms: parseFloat(durationMs),
    };

    if (res.statusCode >= 500) {
      req.logger.error(logData);
    } else if (res.statusCode >= 400) {
      req.logger.warn(logData);
    } else {
      req.logger.info(logData);
    }
  });

  next();
});

// ========================
// Health Check Endpoints
// ========================

/**
 * Basic health check - for load balancer probes
 * Returns 200 if server is running
 */
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Detailed health check - for monitoring dashboards
 * Checks all dependencies and returns their status
 */
app.get('/health/detailed', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime_seconds: process.uptime(),
    version: process.env.APP_VERSION || '1.0.0',
    environment: process.env.NODE_ENV || 'development',
    checks: {},
  };

  // Check PostgreSQL
  try {
    const start = process.hrtime();
    await pool.query('SELECT 1');
    const [s, ns] = process.hrtime(start);
    const latencyMs = (s * 1000 + ns / 1e6).toFixed(2);

    // Get pool stats
    const poolStats = {
      total: pool.totalCount,
      idle: pool.idleCount,
      waiting: pool.waitingCount,
    };

    // Update metrics
    dbConnectionPoolSize.set({ state: 'total' }, poolStats.total);
    dbConnectionPoolSize.set({ state: 'idle' }, poolStats.idle);
    dbConnectionPoolSize.set({ state: 'waiting' }, poolStats.waiting);

    health.checks.database = {
      status: 'healthy',
      latency_ms: parseFloat(latencyMs),
      pool: poolStats,
    };
  } catch (error) {
    health.status = 'unhealthy';
    health.checks.database = {
      status: 'unhealthy',
      error: error.message,
    };
  }

  // Check Redis
  try {
    const start = process.hrtime();
    await redis.ping();
    const [s, ns] = process.hrtime(start);
    const latencyMs = (s * 1000 + ns / 1e6).toFixed(2);

    // Get Redis memory info
    let memoryBytes = 0;
    try {
      const info = await redis.info('memory');
      const match = info.match(/used_memory:(\d+)/);
      if (match) {
        memoryBytes = parseInt(match[1]);
        redisMemoryBytes.set(memoryBytes);
      }
    } catch (e) {
      // Memory info not critical
    }

    health.checks.redis = {
      status: 'healthy',
      latency_ms: parseFloat(latencyMs),
      memory_bytes: memoryBytes,
    };
  } catch (error) {
    health.status = 'unhealthy';
    health.checks.redis = {
      status: 'unhealthy',
      error: error.message,
    };
  }

  // Overall status based on critical services
  const criticalServices = ['database', 'redis'];
  const anyUnhealthy = criticalServices.some(
    (service) => health.checks[service]?.status === 'unhealthy'
  );

  if (anyUnhealthy) {
    health.status = 'unhealthy';
    res.status(503);
  }

  res.json(health);
});

/**
 * Readiness check - for Kubernetes readiness probes
 * Returns 200 only when all dependencies are ready
 */
app.get('/ready', async (req, res) => {
  try {
    // Check both critical dependencies
    await Promise.all([pool.query('SELECT 1'), redis.ping()]);

    res.json({
      ready: true,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(503).json({
      ready: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Liveness check - for Kubernetes liveness probes
 * Returns 200 if the process is running (doesn't check dependencies)
 */
app.get('/live', (req, res) => {
  res.json({
    alive: true,
    timestamp: new Date().toISOString(),
    pid: process.pid,
  });
});

// ========================
// Prometheus Metrics Endpoint
// ========================

/**
 * Prometheus metrics endpoint
 * Exposes all collected metrics in Prometheus format
 */
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getMetricsContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({
      event: 'metrics_error',
      error_message: error.message,
    });
    res.status(500).json({ error: 'Failed to collect metrics' });
  }
});

// ========================
// API Routes
// ========================

const apiRouter = express.Router();

// Mount routes
apiRouter.use('/payment_intents', paymentIntentsRouter);
apiRouter.use('/customers', customersRouter);
apiRouter.use('/payment_methods', paymentMethodsRouter);
apiRouter.use('/refunds', refundsRouter);
apiRouter.use('/webhooks', webhooksRouter);
apiRouter.use('/merchants', merchantsRouter);
apiRouter.use('/balance', balanceRouter);
apiRouter.use('/charges', chargesRouter);

// Mount API router
app.use('/v1', apiRouter);

// ========================
// Root and Documentation
// ========================

app.get('/', (req, res) => {
  res.json({
    name: 'Stripe-like Payment API',
    version: '1.0.0',
    documentation: 'See /docs for API documentation',
    endpoints: {
      payment_intents: '/v1/payment_intents',
      customers: '/v1/customers',
      payment_methods: '/v1/payment_methods',
      refunds: '/v1/refunds',
      charges: '/v1/charges',
      webhooks: '/v1/webhooks',
      balance: '/v1/balance',
      merchants: '/v1/merchants',
    },
    monitoring: {
      health: '/health',
      health_detailed: '/health/detailed',
      ready: '/ready',
      live: '/live',
      metrics: '/metrics',
    },
  });
});

app.get('/docs', (req, res) => {
  res.json({
    title: 'Stripe-like Payment API Documentation',
    authentication: {
      type: 'Bearer token',
      header: 'Authorization: Bearer sk_test_xxx',
      description:
        'All API requests require a valid API key in the Authorization header.',
    },
    endpoints: {
      'POST /v1/merchants': {
        description: 'Create a new merchant account',
        body: { name: 'string', email: 'string' },
        returns: 'Merchant object with API key',
      },
      'POST /v1/payment_intents': {
        description: 'Create a payment intent',
        body: {
          amount: 'integer (cents)',
          currency: 'string (usd, eur, etc.)',
          customer: 'string (optional)',
          payment_method: 'string (optional)',
          capture_method: 'automatic | manual',
        },
        returns: 'PaymentIntent object',
      },
      'POST /v1/payment_intents/:id/confirm': {
        description: 'Confirm a payment intent',
        body: { payment_method: 'string' },
        returns: 'PaymentIntent object',
      },
      'POST /v1/payment_intents/:id/capture': {
        description: 'Capture an authorized payment',
        body: { amount_to_capture: 'integer (optional)' },
        returns: 'PaymentIntent object',
      },
      'POST /v1/payment_methods': {
        description: 'Create a payment method (tokenized card)',
        body: {
          type: 'card',
          card: {
            number: 'string',
            exp_month: 'integer',
            exp_year: 'integer',
            cvc: 'string',
          },
        },
        returns: 'PaymentMethod object',
      },
      'POST /v1/refunds': {
        description: 'Create a refund',
        body: {
          payment_intent: 'string',
          amount: 'integer (optional, defaults to full amount)',
          reason: 'string (optional)',
        },
        returns: 'Refund object',
      },
    },
    test_cards: {
      '4242424242424242': 'Always succeeds',
      '4000000000000002': 'Card declined',
      '4000000000009995': 'Insufficient funds',
      '4000000000000069': 'Expired card',
      '4000000000000127': 'Incorrect CVC',
    },
    idempotency: {
      header: 'Idempotency-Key',
      description:
        'Include an idempotency key to safely retry requests. Keys expire after 24 hours.',
    },
  });
});

// ========================
// Error Handlers
// ========================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: {
      type: 'invalid_request_error',
      message: `Unknown route: ${req.method} ${req.path}`,
    },
  });
});

// Global error handler
app.use((err, req, res, next) => {
  const reqLogger = req.logger || logger;

  reqLogger.error({
    event: 'unhandled_error',
    error_type: err.constructor.name,
    error_message: err.message,
    error_code: err.code,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
  });

  // Handle specific error types
  if (err.name === 'CardNetworkUnavailableError') {
    return res.status(503).json({
      error: {
        type: 'api_error',
        code: 'payment_processor_unavailable',
        message:
          'Payment processor is temporarily unavailable. Please try again.',
      },
    });
  }

  res.status(err.statusCode || 500).json({
    error: {
      type: 'api_error',
      message:
        process.env.NODE_ENV === 'development'
          ? err.message
          : 'An internal error occurred',
    },
  });
});

// ========================
// Graceful Shutdown
// ========================

let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({
    event: 'shutdown_initiated',
    signal,
    message: 'Starting graceful shutdown...',
  });

  // Stop accepting new connections
  server.close(() => {
    logger.info({ event: 'http_server_closed' });
  });

  // Wait for in-flight requests (max 30 seconds)
  const shutdownTimeout = setTimeout(() => {
    logger.warn({ event: 'shutdown_timeout', message: 'Forcing shutdown' });
    process.exit(1);
  }, 30000);

  try {
    // Close database pool
    await pool.end();
    logger.info({ event: 'database_pool_closed' });

    // Close Redis connection
    await redis.quit();
    logger.info({ event: 'redis_connection_closed' });

    clearTimeout(shutdownTimeout);
    logger.info({ event: 'shutdown_complete' });
    process.exit(0);
  } catch (error) {
    logger.error({
      event: 'shutdown_error',
      error_message: error.message,
    });
    process.exit(1);
  }
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ========================
// Server Startup
// ========================

let server;

async function start() {
  try {
    // Connect to Redis
    await redis.connect();
    logger.info({ event: 'redis_connected' });

    // Start webhook worker
    startWebhookWorker();
    logger.info({ event: 'webhook_worker_started' });

    // Start HTTP server
    server = app.listen(PORT, () => {
      logger.info({
        event: 'server_started',
        port: PORT,
        environment: process.env.NODE_ENV || 'development',
        pid: process.pid,
        endpoints: {
          api: `http://localhost:${PORT}`,
          docs: `http://localhost:${PORT}/docs`,
          metrics: `http://localhost:${PORT}/metrics`,
          health: `http://localhost:${PORT}/health/detailed`,
        },
      });
    });
  } catch (error) {
    logger.error({
      event: 'startup_failed',
      error_message: error.message,
      stack: error.stack,
    });
    process.exit(1);
  }
}

start();
