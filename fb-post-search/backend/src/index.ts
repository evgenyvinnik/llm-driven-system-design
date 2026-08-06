/**
 * @fileoverview Express server entry point for the Facebook Post Search API.
 * Configures middleware, initializes services, and starts the HTTP server.
 * Includes Prometheus metrics, structured logging, and comprehensive health checks.
 */

import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { config } from './config/index.js';
import { initializeElasticsearch, esClient, POSTS_INDEX } from './config/elasticsearch.js';
import { query } from './config/database.js';
import { updatePostIndex } from './services/indexingService.js';
import routes from './routes/index.js';
import {
  logger,
  logError,
  metricsRegistry,
  httpRequestsTotal,
  httpRequestDurationSeconds,
  performHealthCheck,
  livenessCheck,
  readinessCheck,
} from './shared/index.js';

/**
 * Express application instance.
 */
const app = express();

// ============================================================================
// Middleware
// ============================================================================

// Request ID middleware for tracing
app.use((req, _res, next) => {
  req.headers['x-request-id'] = req.headers['x-request-id'] || uuidv4();
  next();
});

// CORS configuration
app.use(cors({
  origin: ['http://localhost:5173', 'http://localhost:3000'],
  credentials: true,
}));

// JSON body parser
app.use(express.json());

/**
 * Rate limiter middleware to prevent abuse.
 * Limits each IP to 1000 requests per 15 minutes.
 */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per windowMs
  message: { error: 'Too many requests, please try again later' },
});
app.use(limiter);

/**
 * Request metrics middleware.
 * Records HTTP request count and duration for Prometheus.
 */
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = (Date.now() - start) / 1000;
    const path = normalizePath(req.path);

    httpRequestsTotal.inc({
      method: req.method,
      path,
      status_code: res.statusCode.toString(),
    });

    httpRequestDurationSeconds.observe(
      { method: req.method, path },
      duration
    );
  });

  next();
});

/**
 * Normalizes request path for metrics to avoid high cardinality.
 * Replaces UUIDs and numeric IDs with placeholders.
 */
function normalizePath(path: string): string {
  return path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+/g, '/:id');
}

// ============================================================================
// System Endpoints (not rate-limited, no auth required)
// ============================================================================

/**
 * Prometheus metrics endpoint.
 * Exposes all collected metrics in Prometheus text format.
 */
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  } catch (_error) {
    res.status(500).end('Error collecting metrics');
  }
});

/**
 * Liveness probe endpoint.
 * Returns 200 if the process is running.
 * Used by Kubernetes/container orchestrators.
 */
app.get('/livez', (_req, res) => {
  const status = livenessCheck();
  res.json(status);
});

/**
 * Readiness probe endpoint.
 * Returns 200 if the service is ready to accept traffic.
 * Checks all critical dependencies.
 */
app.get('/readyz', async (_req, res) => {
  const ready = await readinessCheck();
  res.status(ready ? 200 : 503).json({ ready });
});

/**
 * Comprehensive health check endpoint.
 * Returns detailed status of all dependencies.
 */
app.get('/health', async (_req, res) => {
  const health = await performHealthCheck();
  const statusCode = health.status === 'unhealthy' ? 503 : 200;
  res.status(statusCode).json(health);
});

// ============================================================================
// API Routes
// ============================================================================

app.use('/api/v1', routes);

// ============================================================================
// Error Handling
// ============================================================================

// 404 handler
app.use((req, res) => {
  logger.debug({ path: req.path, method: req.method }, 'Route not found');
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError({
    error: err,
    requestId: req.headers['x-request-id'] as string,
    operation: `${req.method} ${req.path}`,
  });

  res.status(500).json({ error: 'Internal server error' });
});

// ============================================================================
// Server Initialization
// ============================================================================

/**
 * Initializes the server and starts listening.
 * Sets up Elasticsearch index, logging, and starts the HTTP server.
 */
async function start() {
  try {
    // Bind the port FIRST. Elasticsearch is slow to become available and is not
    // needed to authenticate or serve non-search routes; blocking the listen on
    // it (and exiting when it wasn't ready yet) meant the port never bound, so
    // even the login request failed at the Vite proxy.
    app.listen(config.port, () => {
      logger.info({
        port: config.port,
        env: config.env,
        metricsEndpoint: `/metrics`,
        healthEndpoint: `/health`,
      }, `Server running on port ${config.port}`);
    });

    for (let attempt = 1; attempt <= 10; attempt++) {
      try {
        await initializeElasticsearch();
        logger.info('Elasticsearch initialized');
        await backfillIndexIfEmpty();
        break;
      } catch (error) {
        if (attempt === 10) {
          logger.error({ error }, 'Elasticsearch unavailable; search endpoints will fail');
          break;
        }
        logger.warn({ attempt }, 'Elasticsearch not ready, retrying in 2s...');
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  } catch (error) {
    logger.fatal({ error }, 'Failed to start server');
    process.exit(1);
  }
}

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception');
  process.exit(1);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});

start();

/**
 * Indexes any posts that exist in Postgres but not in Elasticsearch.
 *
 * Indexing normally happens synchronously inside post-create and there is no
 * re-indexing job, so a SQL fixture that inserts posts directly leaves the
 * index empty and every search returns nothing while the database looks
 * correctly populated. Doing this at boot — rather than at seed time — is what
 * makes it reliable: Elasticsearch is slow to accept connections on a cold
 * start, so a seeder racing it silently skips, and the backend then creates a
 * fresh empty index over the top.
 *
 * It is a no-op whenever the index already has documents, so it costs one count
 * query per boot and never fights a real indexing path.
 */
async function backfillIndexIfEmpty(): Promise<void> {
  try {
    const { count } = await esClient.count({ index: POSTS_INDEX });
    if (count > 0) return;

    const posts = await query<{ id: string }>('SELECT id FROM posts ORDER BY created_at');
    if (posts.length === 0) return;

    let indexed = 0;
    for (const post of posts) {
      try {
        await updatePostIndex(post.id);
        indexed++;
      } catch (error) {
        logger.warn({ error, postId: post.id }, 'Failed to index seeded post');
      }
    }
    logger.info({ indexed, total: posts.length }, 'Backfilled empty search index');
  } catch (error) {
    logger.warn({ error }, 'Index backfill skipped');
  }
}
