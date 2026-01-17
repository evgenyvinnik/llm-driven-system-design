import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import { pool, initializeDatabase, query } from './utils/db.js';
import { redisClient, initializeRedis } from './utils/redis.js';
import { minioClient, initializeMinio } from './utils/minio.js';
import { initializeQueue, isQueueHealthy, getQueueHealth } from './shared/queue.js';
import { getMetrics, metricsMiddleware, envelopesByStatus, signaturesPending } from './shared/metrics.js';
import { getCircuitBreakerHealth } from './shared/circuitBreaker.js';
import { getStorageHealth } from './shared/storageWithBreaker.js';
import logger, { createRequestLogger } from './shared/logger.js';
import { idempotencyMiddleware } from './shared/idempotency.js';

import authRoutes from './routes/auth.js';
import envelopeRoutes from './routes/envelopes.js';
import documentRoutes from './routes/documents.js';
import recipientRoutes from './routes/recipients.js';
import fieldRoutes from './routes/fields.js';
import signingRoutes from './routes/signing.js';
import auditRoutes from './routes/audit.js';
import adminRoutes from './routes/admin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cookieParser());

// Request metrics middleware
app.use(metricsMiddleware);

// Idempotency middleware for POST/PUT/PATCH requests
app.use(idempotencyMiddleware);

// Request logging middleware
app.use((req, res, next) => {
  req.log = createRequestLogger(req);
  req.log.info('Request received');
  next();
});

// Prometheus metrics endpoint
app.get('/metrics', getMetrics);

// Basic liveness probe (fast, no dependency checks)
app.get('/health/live', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Comprehensive health check (checks all dependencies)
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
    uptime: process.uptime(),
    checks: {},
  };

  // Check PostgreSQL
  try {
    const start = Date.now();
    await query('SELECT 1');
    health.checks.postgres = {
      status: 'healthy',
      latencyMs: Date.now() - start,
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
      latencyMs: Date.now() - start,
    };
  } catch (error) {
    health.checks.redis = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Check MinIO
  try {
    const start = Date.now();
    await minioClient.bucketExists('docusign-documents');
    health.checks.minio = {
      status: 'healthy',
      latencyMs: Date.now() - start,
      circuitBreakers: getStorageHealth(),
    };
  } catch (error) {
    health.checks.minio = {
      status: 'unhealthy',
      error: error.message,
      circuitBreakers: getStorageHealth(),
    };
    health.status = 'degraded';
  }

  // Check RabbitMQ
  try {
    const queueHealth = await getQueueHealth();
    health.checks.rabbitmq = {
      status: isQueueHealthy() ? 'healthy' : 'unhealthy',
      ...queueHealth,
    };
    if (!isQueueHealthy()) {
      health.status = 'degraded';
    }
  } catch (error) {
    health.checks.rabbitmq = {
      status: 'unhealthy',
      error: error.message,
    };
    health.status = 'degraded';
  }

  // Add circuit breaker states
  health.circuitBreakers = getCircuitBreakerHealth();

  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

// Readiness probe (service ready to accept traffic)
app.get('/health/ready', async (req, res) => {
  try {
    // Quick checks for essential services
    await Promise.all([
      query('SELECT 1'),
      redisClient.ping(),
    ]);
    res.json({ ready: true, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(503).json({
      ready: false,
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
});

// API Routes
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/envelopes', envelopeRoutes);
app.use('/api/v1/documents', documentRoutes);
app.use('/api/v1/recipients', recipientRoutes);
app.use('/api/v1/fields', fieldRoutes);
app.use('/api/v1/signing', signingRoutes);
app.use('/api/v1/audit', auditRoutes);
app.use('/api/v1/admin', adminRoutes);

// Error handler with structured logging
app.use((err, req, res, next) => {
  const log = req.log || logger;
  log.error({
    error: err.message,
    stack: err.stack,
    statusCode: err.status || 500,
  }, 'Request error');

  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

// Background task: Update envelope status metrics periodically
async function updateEnvelopeMetrics() {
  try {
    const result = await query(`
      SELECT status, COUNT(*) as count
      FROM envelopes
      GROUP BY status
    `);

    // Reset all status gauges
    for (const status of ['draft', 'sent', 'delivered', 'signed', 'completed', 'declined', 'voided']) {
      envelopesByStatus.set({ status }, 0);
    }

    // Update with current counts
    for (const row of result.rows) {
      envelopesByStatus.set({ status: row.status }, parseInt(row.count));
    }

    // Update pending signatures count
    const pendingResult = await query(`
      SELECT COUNT(*) as count
      FROM document_fields df
      JOIN documents d ON df.document_id = d.id
      JOIN envelopes e ON d.envelope_id = e.id
      WHERE df.type = 'signature'
        AND df.completed = false
        AND e.status IN ('sent', 'delivered')
    `);
    signaturesPending.set(parseInt(pendingResult.rows[0].count));

  } catch (error) {
    logger.error({ error: error.message }, 'Failed to update envelope metrics');
  }
}

// Initialize services and start server
async function start() {
  try {
    // Initialize database connection
    await initializeDatabase();
    logger.info('Database connected');

    // Initialize Redis
    await initializeRedis();
    logger.info('Redis connected');

    // Initialize MinIO
    await initializeMinio();
    logger.info('MinIO connected');

    // Initialize RabbitMQ (optional for local dev)
    try {
      await initializeQueue();
      logger.info('RabbitMQ connected');
    } catch (error) {
      logger.warn({ error: error.message }, 'RabbitMQ not available - notifications will be synchronous');
    }

    // Start metrics update interval
    setInterval(updateEnvelopeMetrics, 30000); // Every 30 seconds
    await updateEnvelopeMetrics(); // Initial update

    app.listen(PORT, () => {
      logger.info({ port: PORT }, `DocuSign backend running on port ${PORT}`);
    });
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to start server');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

start();
