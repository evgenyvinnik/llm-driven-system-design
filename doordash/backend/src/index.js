import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { createServer } from 'http';

import { setupWebSocket } from './websocket.js';
import { authMiddleware } from './middleware/auth.js';

import authRoutes from './routes/auth.js';
import restaurantRoutes from './routes/restaurants.js';
import orderRoutes from './routes/orders.js';
import driverRoutes from './routes/drivers.js';

// Shared modules
import logger, { requestLogger } from './shared/logger.js';
import { metricsMiddleware, getMetrics, getContentType } from './shared/metrics.js';
import { initializeKafka, closeKafka, isKafkaReady } from './shared/kafka.js';
import pool from './db.js';
import redisClient from './redis.js';

const app = express();
const server = createServer(app);

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  })
);
app.use(express.json());
app.use(cookieParser());

// Add structured logging middleware
app.use(requestLogger);

// Add metrics collection middleware
app.use(metricsMiddleware);

// Auth middleware
app.use(authMiddleware);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/restaurants', restaurantRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/drivers', driverRoutes);

// Health check endpoint - comprehensive check of all dependencies
app.get('/health', async (req, res) => {
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    checks: {},
  };

  // Check PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    health.checks.postgres = {
      status: 'healthy',
      latency: Date.now() - start,
    };
  } catch (error) {
    health.checks.postgres = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check Redis
  try {
    const start = Date.now();
    await redisClient.ping();
    health.checks.redis = {
      status: 'healthy',
      latency: Date.now() - start,
    };
  } catch (error) {
    health.checks.redis = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check Kafka
  health.checks.kafka = {
    status: isKafkaReady() ? 'healthy' : 'unavailable',
    note: 'Event streaming',
  };

  // Memory usage
  const memUsage = process.memoryUsage();
  health.memory = {
    heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024) + 'MB',
    heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024) + 'MB',
    rss: Math.round(memUsage.rss / 1024 / 1024) + 'MB',
  };

  const statusCode = health.status === 'ok' ? 200 : 503;
  res.status(statusCode).json(health);
});

// Liveness check - simple check that the service is running
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness check - service is ready to receive traffic
app.get('/health/ready', async (req, res) => {
  try {
    // Check if both postgres and redis are available
    await Promise.all([pool.query('SELECT 1'), redisClient.ping()]);
    res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({
      status: 'not ready',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
  try {
    res.set('Content-Type', getContentType());
    res.end(await getMetrics());
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to get metrics');
    res.status(500).end(error.message);
  }
});

// Setup WebSocket
setupWebSocket(server);

const PORT = process.env.PORT || 3000;

// Initialize Kafka (non-blocking)
initializeKafka().catch((error) => {
  logger.warn({ error: error.message }, 'Kafka initialization failed - events will not be published');
});

server.listen(PORT, () => {
  logger.info({ port: PORT }, 'Server started');
  logger.info({ wsPath: `/ws` }, 'WebSocket available');
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');

  server.close(async () => {
    logger.info('HTTP server closed');

    try {
      await pool.end();
      logger.info('PostgreSQL connection pool closed');
    } catch (error) {
      logger.error({ error: error.message }, 'Error closing PostgreSQL');
    }

    try {
      await redisClient.quit();
      logger.info('Redis connection closed');
    } catch (error) {
      logger.error({ error: error.message }, 'Error closing Redis');
    }

    try {
      await closeKafka();
      logger.info('Kafka connection closed');
    } catch (error) {
      logger.error({ error: error.message }, 'Error closing Kafka');
    }

    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received');
  process.emit('SIGTERM');
});

// Log unhandled errors
process.on('uncaughtException', (error) => {
  logger.fatal({ error: error.message, stack: error.stack }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
});
