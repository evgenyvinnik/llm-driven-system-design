/**
 * Apple Pay Backend Server Entry Point
 *
 * This is the main entry point for the Apple Pay demo backend.
 * It sets up an Express server with the following capabilities:
 * - Authentication and device management (/api/auth)
 * - Payment card provisioning and management (/api/cards)
 * - Payment processing with biometric auth (/api/payments)
 * - Merchant integration endpoints (/api/merchants)
 *
 * The server requires PostgreSQL for persistent storage and
 * Redis for session management and caching.
 *
 * New Infrastructure Features:
 * - Structured logging with Pino (JSON format)
 * - Prometheus metrics at /metrics
 * - Deep health checks at /health, /health/live, /health/ready
 * - Circuit breakers for payment network resilience
 * - Idempotency middleware for payment safety
 * - Audit logging for compliance
 */
import express from 'express';
import cors from 'cors';
import redis from './db/redis.js';
import pool from './db/index.js';
import authRoutes from './routes/auth.js';
import cardsRoutes from './routes/cards.js';
import paymentsRoutes from './routes/payments.js';
import merchantsRoutes from './routes/merchants.js';

// Import shared infrastructure modules
import {
  logger,
  requestLogger,
  metricsMiddleware,
  createMetricsRouter,
  healthRouter,
} from './shared/index.js';

/** Express application instance */
const app = express();

/** Server port from environment or default 3000 */
const PORT = process.env.PORT || 3000;

// Middleware - CORS configuration
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  })
);

// Body parsing
app.use(express.json());

// Prometheus metrics collection middleware
// Records request duration and counts by method, route, and status
app.use(metricsMiddleware);

// Structured logging middleware with request correlation
// Adds requestId to each request and logs request/response details
app.use(requestLogger);

// Health check endpoints
// - /health/live: Liveness probe for container orchestration
// - /health/ready: Readiness probe for load balancers
// - /health or /health/deep: Detailed component status
app.use('/health', healthRouter);

// Prometheus metrics endpoint
// Exposes application and Node.js metrics in Prometheus format
app.use(createMetricsRouter());

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/cards', cardsRoutes);
app.use('/api/payments', paymentsRoutes);
app.use('/api/merchants', merchantsRoutes);

// Global error handling with structured logging
app.use(
  (
    err: Error,
    req: express.Request & { requestId?: string },
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logger.error(
      {
        error: err.message,
        stack: err.stack,
        requestId: req.requestId,
        path: req.path,
        method: req.method,
      },
      'Unhandled error'
    );
    res.status(500).json({
      error: 'Internal server error',
      requestId: req.requestId,
    });
  }
);

/**
 * Initializes and starts the Express server.
 * Establishes connections to Redis and PostgreSQL before listening.
 * Exits with code 1 if connections fail.
 */
async function start() {
  try {
    // Connect to Redis
    await redis.connect();
    logger.info('Connected to Redis');

    // Verify database connection
    await pool.query('SELECT 1');
    logger.info('Connected to PostgreSQL');

    app.listen(PORT, () => {
      logger.info(
        {
          port: PORT,
          nodeEnv: process.env.NODE_ENV || 'development',
        },
        'Apple Pay server started'
      );
      logger.info(`Health check: http://localhost:${PORT}/health`);
      logger.info(`Metrics: http://localhost:${PORT}/metrics`);
    });
  } catch (error) {
    logger.fatal({ error: (error as Error).message }, 'Failed to start server');
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  try {
    await redis.quit();
    await pool.end();
    logger.info('Connections closed');
    process.exit(0);
  } catch (error) {
    logger.error({ error: (error as Error).message }, 'Error during shutdown');
    process.exit(1);
  }
});

start();

export default app;
