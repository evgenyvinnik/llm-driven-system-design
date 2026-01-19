import express from 'express';
import cors from 'cors';
import { pool, initDatabase } from './utils/database.js';
import { redis } from './utils/redis.js';
import { initRabbitMQ, getChannel } from './utils/rabbitmq.js';
import { createLogger, requestLogger } from './utils/logger.js';
import { metricsMiddleware, getMetrics, activeConnections } from './utils/metrics.js';
import { getAllCircuitBreakerStates, initializeCircuitBreakers } from './utils/circuitBreaker.js';
import authRoutes from './routes/auth.js';
import notificationRoutes from './routes/notifications.js';
import preferenceRoutes from './routes/preferences.js';
import templateRoutes from './routes/templates.js';
import campaignRoutes from './routes/campaigns.js';
import adminRoutes from './routes/admin.js';
import { authMiddleware } from './middleware/auth.js';

const log = createLogger('api-server');
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:5174'],
  credentials: true
}));
app.use(express.json());

// Structured request logging
app.use(requestLogger());

// Prometheus metrics middleware
app.use(metricsMiddleware);

// Prometheus metrics endpoint
app.get('/metrics', getMetrics);

/**
 * Enhanced health check endpoint with detailed component status
 *
 * Returns:
 * - status: 'healthy' | 'degraded' | 'unhealthy'
 * - components: detailed status of each dependency
 * - circuitBreakers: current state of all circuit breakers
 *
 * Use cases:
 * - Kubernetes liveness/readiness probes
 * - Load balancer health checks
 * - Monitoring dashboards
 */
app.get('/health', async (req, res) => {
  const components = {};
  let overallStatus = 'healthy';

  // Check PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    components.postgres = {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    components.postgres = {
      status: 'unhealthy',
      error: error.message,
    };
    overallStatus = 'unhealthy';
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    components.redis = {
      status: 'healthy',
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    components.redis = {
      status: 'unhealthy',
      error: error.message,
    };
    overallStatus = 'unhealthy';
  }

  // Check RabbitMQ
  try {
    const channel = getChannel();
    if (channel) {
      components.rabbitmq = { status: 'healthy' };
    } else {
      components.rabbitmq = {
        status: 'degraded',
        error: 'Channel not initialized',
      };
      if (overallStatus === 'healthy') {
        overallStatus = 'degraded';
      }
    }
  } catch (error) {
    components.rabbitmq = {
      status: 'unhealthy',
      error: error.message,
    };
    overallStatus = 'unhealthy';
  }

  // Get circuit breaker states
  const circuitBreakers = getAllCircuitBreakerStates();

  // Check if any circuit breaker is open
  const openBreakers = Object.entries(circuitBreakers)
    .filter(([, state]) => state === 'open');

  if (openBreakers.length > 0 && overallStatus === 'healthy') {
    overallStatus = 'degraded';
  }

  const statusCode = overallStatus === 'unhealthy' ? 503 : 200;

  res.status(statusCode).json({
    status: overallStatus,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    components,
    circuitBreakers,
    version: process.env.npm_package_version || '1.0.0',
  });
});

/**
 * Liveness probe - simple check that the process is running
 * Use for Kubernetes liveness probes
 */
app.get('/health/live', (req, res) => {
  res.json({ status: 'alive', timestamp: new Date().toISOString() });
});

/**
 * Readiness probe - checks if the service can accept traffic
 * Use for Kubernetes readiness probes and load balancer health checks
 */
app.get('/health/ready', async (req, res) => {
  try {
    // Quick checks only - must be fast
    await Promise.all([
      pool.query('SELECT 1'),
      redis.ping(),
    ]);

    res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (error) {
    log.error({ err: error }, 'Readiness check failed');
    res.status(503).json({
      status: 'not_ready',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Public routes
app.use('/api/v1/auth', authRoutes);

// Protected routes
app.use('/api/v1/notifications', authMiddleware, notificationRoutes);
app.use('/api/v1/preferences', authMiddleware, preferenceRoutes);
app.use('/api/v1/templates', authMiddleware, templateRoutes);
app.use('/api/v1/campaigns', authMiddleware, campaignRoutes);
app.use('/api/v1/admin', authMiddleware, adminRoutes);

// Error handling middleware with structured logging
app.use((err, req, res, next) => {
  const logContext = {
    err,
    reqId: req.id,
    method: req.method,
    url: req.url,
    userId: req.user?.id,
  };

  // Log error with appropriate level
  if (err.status >= 500 || !err.status) {
    log.error(logContext, 'Server error');
  } else if (err.status >= 400) {
    log.warn(logContext, 'Client error');
  }

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error',
    code: err.code,
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// Track active connections
let connectionCount = 0;

// Initialize and start
async function start() {
  try {
    // Initialize database connection
    await initDatabase();
    log.info('Database connected');

    // Initialize RabbitMQ
    await initRabbitMQ();
    log.info('RabbitMQ connected');

    // Initialize circuit breakers for delivery channels
    initializeCircuitBreakers();
    log.info('Circuit breakers initialized');

    const server = app.listen(PORT, () => {
      log.info({ port: PORT }, `Notification API server running on port ${PORT}`);
    });

    // Track connections for graceful shutdown
    server.on('connection', (socket) => {
      connectionCount++;
      activeConnections.labels('http').set(connectionCount);

      socket.on('close', () => {
        connectionCount--;
        activeConnections.labels('http').set(connectionCount);
      });
    });

    // Graceful shutdown handler
    const shutdown = async (signal) => {
      log.info({ signal }, 'Received shutdown signal, starting graceful shutdown');

      server.close(async () => {
        log.info('HTTP server closed');

        try {
          await pool.end();
          log.info('Database pool closed');

          await redis.quit();
          log.info('Redis connection closed');

          log.info('Graceful shutdown complete');
          process.exit(0);
        } catch (error) {
          log.error({ err: error }, 'Error during shutdown');
          process.exit(1);
        }
      });

      // Force shutdown after 30 seconds
      setTimeout(() => {
        log.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    log.fatal({ err: error }, 'Failed to start server');
    process.exit(1);
  }
}

start();
