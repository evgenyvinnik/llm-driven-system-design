/**
 * News Aggregator Backend Server
 * Main entry point for the Express application.
 * Configures middleware, routes, and scheduled tasks for RSS feed crawling.
 * @module index
 */

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { sessionStore, redis } from './db/redis.js';
import { initElasticsearch, esClient } from './db/elasticsearch.js';
import { pool } from './db/postgres.js';
import { crawlAllDueSources } from './services/crawler.js';
import feedRoutes from './routes/feed.js';
import userRoutes from './routes/user.js';
import adminRoutes from './routes/admin.js';

// Shared modules
import { logger, requestLoggerMiddleware } from './shared/logger.js';
import { getMetrics, getMetricsContentType, metricsMiddleware } from './shared/metrics.js';
import { config, validateConfig } from './shared/config.js';
import { getAllCircuitBreakerStats } from './shared/circuit-breaker.js';
import { getCacheStats } from './shared/cache.js';

const app = express();

/** Server port from environment or default 3000 */
const PORT = config.server.port;

// Validate configuration on startup
const { warnings } = validateConfig();
if (warnings.length > 0) {
  warnings.forEach(warning => logger.warn({ warning }, 'Configuration warning'));
}

// Middleware
app.use(cors({
  origin: config.server.frontendUrl,
  credentials: true,
}));
app.use(express.json());

// Request logging middleware
if (config.features.enableRequestLogging) {
  app.use(requestLoggerMiddleware());
}

// Prometheus metrics middleware
if (config.features.enableMetrics) {
  app.use(metricsMiddleware());
}

/**
 * Cookie parser middleware.
 * Simple implementation that parses the Cookie header into req.cookies object.
 */
app.use((req, _res, next) => {
  const cookieHeader = req.headers.cookie;
  req.cookies = {};
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      req.cookies[name] = decodeURIComponent(value);
    });
  }
  next();
});

/**
 * Session middleware.
 * Loads session data from Redis using session_id cookie or X-Session-Id header.
 */
app.use(async (req, _res, next) => {
  const sessionId = req.cookies?.session_id || req.headers['x-session-id'];
  if (sessionId) {
    try {
      const session = await sessionStore.get(sessionId as string);
      if (session) {
        (req as express.Request & { session: unknown }).session = session;
      }
    } catch (err) {
      // Express 4 does not catch rejected async middleware: without this the
      // request would hang during a Redis outage. Continue as anonymous.
      logger.warn({ error: (err as Error).message }, 'Session lookup failed; continuing unauthenticated');
    }
  }
  next();
});

// Declare cookies on Request
declare global {
  namespace Express {
    interface Request {
      /** Parsed cookies from Cookie header */
      cookies: Record<string, string>;
      /** Session data loaded from Redis */
      session?: Record<string, unknown>;
    }
  }
}

/**
 * GET /health - Basic health check endpoint (liveness probe)
 * Returns server status for load balancer and monitoring.
 * Fast, does not check dependencies.
 */
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'news-aggregator',
    version: '1.0.0',
  });
});

/**
 * GET /health/live - Liveness probe
 * Simple check that the server is running.
 */
app.get('/health/live', (_req, res) => {
  res.json({ status: 'ok' });
});

/**
 * GET /health/ready - Readiness probe
 * Checks all dependencies before declaring ready to serve traffic.
 */
app.get('/health/ready', async (_req, res) => {
  const checks: Record<string, { status: string; latencyMs?: number; error?: string }> = {};
  let allHealthy = true;

  // Check PostgreSQL
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    checks.postgres = { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    checks.postgres = { status: 'error', error: (err as Error).message };
    allHealthy = false;
  }

  // Check Redis
  try {
    const start = Date.now();
    await redis.ping();
    checks.redis = { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    checks.redis = { status: 'error', error: (err as Error).message };
    allHealthy = false;
  }

  // Check Elasticsearch
  try {
    const start = Date.now();
    await esClient.ping();
    checks.elasticsearch = { status: 'ok', latencyMs: Date.now() - start };
  } catch (err) {
    checks.elasticsearch = { status: 'error', error: (err as Error).message };
    // Elasticsearch is optional - search degrades gracefully
    checks.elasticsearch.status = 'degraded';
  }

  const status = allHealthy ? 'ready' : 'not ready';
  res.status(allHealthy ? 200 : 503).json({
    status,
    timestamp: new Date().toISOString(),
    checks,
  });
});

/**
 * GET /health/detailed - Detailed health check with metrics
 * Returns comprehensive health information including circuit breakers and cache.
 */
app.get('/health/detailed', async (_req, res) => {
  const checks: Record<string, unknown> = {};

  // PostgreSQL connection pool stats
  checks.postgres = {
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
  };

  // Redis/Cache stats
  checks.cache = await getCacheStats();

  // Circuit breaker stats
  const breakerStats = getAllCircuitBreakerStats();
  checks.circuitBreakers = Object.fromEntries(breakerStats);

  // Configuration (non-sensitive)
  checks.config = {
    retention: config.retention,
    crawler: {
      maxConcurrentCrawls: config.crawler.maxConcurrentCrawls,
      requestTimeoutMs: config.crawler.requestTimeoutMs,
    },
  };

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    checks,
  });
});

/**
 * GET /metrics - Prometheus metrics endpoint
 * Returns application metrics in Prometheus format.
 */
if (config.features.enableMetrics) {
  app.get('/metrics', async (_req, res) => {
    try {
      const metrics = await getMetrics();
      res.set('Content-Type', getMetricsContentType());
      res.send(metrics);
    } catch (err) {
      logger.error({ error: err }, 'Failed to generate metrics');
      res.status(500).send('Failed to generate metrics');
    }
  });
}

// API routes
app.use('/api/v1', feedRoutes);
app.use('/api/v1/user', userRoutes);
app.use('/api/v1/admin', adminRoutes);

/**
 * Global error handler.
 * Logs unhandled errors and returns 500 response.
 */
app.use((err: Error, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
  }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
});

/** The scheduled crawl currently running in this process, if any. */
let crawlInFlight: Promise<unknown> | null = null;

/**
 * Run one scheduled crawl pass unless one is already running here.
 * (Across instances, the leases in crawl_schedule prevent double crawling.)
 * @param label - 'scheduled' or 'initial', for logs
 */
function runScheduledCrawl(label: string): void {
  if (crawlInFlight) {
    logger.info({ label }, 'Previous crawl still running; skipping this tick');
    return;
  }
  crawlInFlight = crawlAllDueSources()
    .then(results => {
      logger.info({
        label,
        sourcesCount: results.length,
        newArticles: results.reduce((sum, r) => sum + r.articles_new, 0),
      }, 'Crawl pass completed');
    })
    .catch(err => logger.error({ label, error: (err as Error).message }, 'Crawl pass failed'))
    .finally(() => { crawlInFlight = null; });
}

/**
 * Create the Elasticsearch indexes, retrying in the background.
 * Search is a degradable feature (PostgreSQL full-text search answers while
 * Elasticsearch is away), so its absence must not stop the API from starting.
 * @param attempt - Attempt number, for backoff
 */
async function initSearchIndex(attempt = 1): Promise<void> {
  try {
    await initElasticsearch();
    logger.info('Elasticsearch initialized');
  } catch (err) {
    const delayMs = Math.min(30000, 2000 * attempt);
    logger.warn({ attempt, retryInMs: delayMs, error: (err as Error).message },
      'Elasticsearch unavailable; search will use PostgreSQL until it is reachable');
    setTimeout(() => { void initSearchIndex(attempt + 1); }, delayMs).unref();
  }
}

let server: ReturnType<typeof app.listen> | null = null;
let crawlTask: ReturnType<typeof cron.schedule> | null = null;

/**
 * Initialize and start the server.
 * Starts HTTP immediately; Elasticsearch setup and crawling run alongside.
 */
async function start() {
  server = app.listen(PORT, () => {
    logger.info({ port: PORT }, 'News Aggregator server started');
  });

  void initSearchIndex();

  if (config.crawler.enabled) {
    // Every instance may run the schedule: claiming sources under a lease
    // means each due source is crawled by exactly one of them.
    crawlTask = cron.schedule('*/15 * * * *', () => runScheduledCrawl('scheduled'));
    setTimeout(() => runScheduledCrawl('initial'), 10000).unref();
    logger.info('Scheduled crawl every 15 minutes');
  } else {
    logger.info('CRAWLER_ENABLED=false: scheduled crawling disabled in this process');
  }

  logger.info({
    retention: config.retention,
    features: config.features,
  }, 'Server configuration');
}

/**
 * Graceful shutdown: stop accepting requests and scheduling crawls, give an
 * in-flight crawl up to 10 seconds to finish (an unfinished one is safe: its
 * lease simply expires), then close PostgreSQL and Redis.
 * @param signal - The signal received
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down gracefully');
  crawlTask?.stop();
  const forceExit = setTimeout(() => process.exit(1), 15000);
  forceExit.unref();

  await new Promise<void>(resolve => (server ? server.close(() => resolve()) : resolve()));
  if (crawlInFlight) {
    await Promise.race([crawlInFlight, new Promise(resolve => setTimeout(resolve, 10000))]);
  }
  await pool.end();
  redis.disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

start();
