import express from 'express';
import cors from 'cors';
import { Client } from '@elastic/elasticsearch';
import pg from 'pg';
import searchRoutes from './routes/search.js';
import indexRoutes from './routes/index.js';
import suggestionsRoutes from './routes/suggestions.js';
import { initializeElasticsearch } from './services/elasticsearch.js';
import logger, { healthLogger, logAuditEvent } from './shared/logger.js';
import { metricsMiddleware, getMetrics, getContentType, serviceHealth } from './shared/metrics.js';
import { globalRateLimiter } from './shared/rateLimiter.js';
import { getAllCircuitBreakerStates } from './shared/circuitBreaker.js';
import { getIdempotencyStore } from './shared/idempotency.js';

const { Pool } = pg;

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Global rate limiter (applied to all routes)
app.use(globalRateLimiter);

// Prometheus metrics middleware (tracks all HTTP requests)
app.use(metricsMiddleware);

// Request ID middleware for tracing
app.use((req, res, next) => {
  req.requestId = req.headers['x-request-id'] || `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  res.set('X-Request-ID', req.requestId);
  next();
});

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      durationMs: duration,
      requestId: req.requestId,
      userAgent: req.headers['user-agent'],
      ip: req.ip
    }, 'HTTP request completed');
  });

  next();
});

// Database connections
export const pool = new Pool({
  host: process.env.PG_HOST || 'localhost',
  port: process.env.PG_PORT || 5432,
  database: process.env.PG_DATABASE || 'spotlight',
  user: process.env.PG_USER || 'spotlight',
  password: process.env.PG_PASSWORD || 'spotlight_password',
});

export const esClient = new Client({
  node: process.env.ES_URL || 'http://localhost:9200',
});

// Routes
app.use('/api/search', searchRoutes);
app.use('/api/index', indexRoutes);
app.use('/api/suggestions', suggestionsRoutes);

// ============================================================================
// Prometheus Metrics Endpoint
// ============================================================================
app.get('/metrics', async (req, res) => {
  try {
    const metrics = await getMetrics();
    res.set('Content-Type', getContentType());
    res.send(metrics);
  } catch (error) {
    logger.error({ error: error.message }, 'Failed to generate metrics');
    res.status(500).json({ error: 'Failed to generate metrics' });
  }
});

// ============================================================================
// Enhanced Health Check Endpoint
// ============================================================================
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    uptime: process.uptime(),
    components: {}
  };

  let isHealthy = true;

  // Check PostgreSQL
  try {
    const startPg = Date.now();
    await pool.query('SELECT 1');
    const pgLatency = Date.now() - startPg;
    health.components.postgres = {
      status: 'healthy',
      latencyMs: pgLatency
    };
    serviceHealth.labels('postgres').set(1);
  } catch (error) {
    health.components.postgres = {
      status: 'unhealthy',
      error: error.message
    };
    serviceHealth.labels('postgres').set(0);
    isHealthy = false;
    healthLogger.error({ component: 'postgres', error: error.message }, 'PostgreSQL health check failed');
  }

  // Check Elasticsearch
  try {
    const startEs = Date.now();
    await esClient.ping();
    const esLatency = Date.now() - startEs;
    health.components.elasticsearch = {
      status: 'healthy',
      latencyMs: esLatency
    };
    serviceHealth.labels('elasticsearch').set(1);

    // Get Elasticsearch cluster health
    const clusterHealth = await esClient.cluster.health();
    health.components.elasticsearch.clusterStatus = clusterHealth.status;
  } catch (error) {
    health.components.elasticsearch = {
      status: 'unhealthy',
      error: error.message
    };
    serviceHealth.labels('elasticsearch').set(0);
    isHealthy = false;
    healthLogger.error({ component: 'elasticsearch', error: error.message }, 'Elasticsearch health check failed');
  }

  // Get circuit breaker states
  health.circuitBreakers = getAllCircuitBreakerStates();

  // Get idempotency store stats
  health.idempotencyStore = {
    entries: getIdempotencyStore().size()
  };

  // Memory usage
  const memUsage = process.memoryUsage();
  health.memory = {
    heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
    rssMB: Math.round(memUsage.rss / 1024 / 1024)
  };

  if (!isHealthy) {
    health.status = 'unhealthy';
  }

  const statusCode = isHealthy ? 200 : 503;
  res.status(statusCode).json(health);
});

// Readiness check (for Kubernetes-style deployments)
app.get('/ready', async (req, res) => {
  try {
    // Quick checks to verify service is ready to accept traffic
    await pool.query('SELECT 1');
    await esClient.ping();
    res.json({ ready: true });
  } catch (error) {
    res.status(503).json({ ready: false, error: error.message });
  }
});

// Liveness check (simple check that the process is running)
app.get('/alive', (req, res) => {
  res.json({ alive: true, uptime: process.uptime() });
});

// ============================================================================
// Error Handling
// ============================================================================
app.use((err, req, res, next) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    requestId: req.requestId,
    method: req.method,
    path: req.path
  }, 'Unhandled error');

  res.status(500).json({
    error: 'Internal server error',
    requestId: req.requestId
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    path: req.path
  });
});

// ============================================================================
// Server Initialization
// ============================================================================
async function start() {
  try {
    // Initialize Elasticsearch indices
    await initializeElasticsearch(esClient);
    logger.info('Elasticsearch initialized');

    // Test PostgreSQL connection
    await pool.query('SELECT 1');
    logger.info('PostgreSQL connected');

    app.listen(PORT, () => {
      logger.info({ port: PORT }, `Spotlight backend running on port ${PORT}`);
      logAuditEvent({
        eventType: 'SERVER_STARTED',
        userId: null,
        ip: null,
        details: { port: PORT }
      });
    });
  } catch (error) {
    logger.fatal({ error: error.message }, 'Failed to start server');
    process.exit(1);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  logAuditEvent({
    eventType: 'SERVER_SHUTDOWN',
    userId: null,
    ip: null,
    details: { signal: 'SIGTERM' }
  });

  // Close database connections
  await pool.end();
  await esClient.close();

  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, shutting down gracefully');
  logAuditEvent({
    eventType: 'SERVER_SHUTDOWN',
    userId: null,
    ip: null,
    details: { signal: 'SIGINT' }
  });

  await pool.end();
  await esClient.close();

  process.exit(0);
});

start();
