import express from 'express';
import cors from 'cors';
import Redis from 'ioredis';
import pg from 'pg';

import { Trie } from './data-structures/trie.js';
import { SuggestionService } from './services/suggestion-service.js';
import { RankingService } from './services/ranking-service.js';
import { AggregationService } from './services/aggregation-service.js';
import suggestionRoutes from './routes/suggestions.js';
import analyticsRoutes from './routes/analytics.js';
import adminRoutes from './routes/admin.js';

// Shared modules for observability, resilience, and rate limiting
import logger, { httpLogger, auditLogger } from './shared/logger.js';
import {
  getMetrics,
  getMetricsContentType,
  updateTrieMetrics,
  updateAggregationMetrics,
} from './shared/metrics.js';
import { getCircuitStatus } from './shared/circuit-breaker.js';
import { globalRateLimiter } from './shared/rate-limiter.js';
import { cleanup as cleanupIdempotency, createRedisIdempotencyHandler } from './shared/idempotency.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(httpLogger); // Structured request logging
app.use(globalRateLimiter); // Global rate limiting

// Database connections
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
});

const pgPool = new pg.Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'typeahead',
  password: process.env.PG_PASSWORD || 'typeahead_password',
  database: process.env.PG_DATABASE || 'typeahead',
  max: 20,
});

// Initialize services
const trie = new Trie(10); // Top 10 suggestions per node
const rankingService = new RankingService(redis);
const suggestionService = new SuggestionService(trie, redis, rankingService);
const aggregationService = new AggregationService(redis, pgPool, trie);

// Initialize Redis-based idempotency handler
const idempotencyHandler = createRedisIdempotencyHandler(redis);

// Make services available to routes
app.set('redis', redis);
app.set('pgPool', pgPool);
app.set('trie', trie);
app.set('suggestionService', suggestionService);
app.set('rankingService', rankingService);
app.set('aggregationService', aggregationService);
app.set('idempotencyHandler', idempotencyHandler);
app.set('logger', logger);
app.set('auditLogger', auditLogger);

// Routes
app.use('/api/v1/suggestions', suggestionRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/admin', adminRoutes);

/**
 * Prometheus metrics endpoint
 * WHY: Metrics enable SLO monitoring, capacity planning, and ranking optimization
 */
app.get('/metrics', async (req, res) => {
  try {
    // Update trie metrics before scraping
    const trieStats = trie.getStats();
    updateTrieMetrics(trieStats);

    // Update aggregation metrics
    const aggStats = aggregationService.getStats();
    updateAggregationMetrics(aggStats.bufferSize);

    res.set('Content-Type', getMetricsContentType());
    res.end(await getMetrics());
  } catch (error) {
    logger.error({ event: 'metrics_error', error: error.message });
    res.status(500).end();
  }
});

/**
 * Basic liveness probe
 */
app.get('/health', async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Comprehensive readiness probe
 * WHY: Readiness probes ensure traffic only goes to healthy instances
 */
app.get('/health/ready', async (req, res) => {
  const checks = {
    trie: { status: 'unknown' },
    redis: { status: 'unknown' },
    postgres: { status: 'unknown' },
  };

  // Check trie is loaded
  try {
    const stats = trie.getStats();
    checks.trie = {
      status: stats.phraseCount > 0 ? 'healthy' : 'degraded',
      phraseCount: stats.phraseCount,
      nodeCount: stats.nodeCount,
    };
  } catch (error) {
    checks.trie = { status: 'unhealthy', error: error.message };
  }

  // Check Redis connectivity
  try {
    const pong = await redis.ping();
    checks.redis = { status: pong === 'PONG' ? 'healthy' : 'unhealthy' };
  } catch (error) {
    checks.redis = { status: 'unhealthy', error: error.message };
  }

  // Check PostgreSQL connectivity
  try {
    await pgPool.query('SELECT 1');
    checks.postgres = { status: 'healthy' };
  } catch (error) {
    checks.postgres = { status: 'unhealthy', error: error.message };
  }

  const allHealthy = Object.values(checks).every((c) => c.status === 'healthy');
  const anyUnhealthy = Object.values(checks).some((c) => c.status === 'unhealthy');

  const overallStatus = allHealthy ? 'healthy' : anyUnhealthy ? 'unhealthy' : 'degraded';

  res.status(overallStatus === 'unhealthy' ? 503 : 200).json({
    status: overallStatus,
    checks,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Circuit breaker status endpoint
 * WHY: Visibility into circuit breaker states for debugging
 */
app.get('/health/circuits', async (req, res) => {
  const circuits = getCircuitStatus();
  res.json({
    circuits,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Detailed status endpoint for debugging
 */
app.get('/status', async (req, res) => {
  try {
    // Check Redis
    let redisStatus = 'unknown';
    let redisInfo = {};
    try {
      const pong = await redis.ping();
      redisStatus = pong === 'PONG' ? 'connected' : 'error';
      const info = await redis.info('memory');
      const memMatch = info.match(/used_memory_human:([^\r\n]+)/);
      redisInfo.memory = memMatch ? memMatch[1] : 'unknown';
    } catch (e) {
      redisStatus = 'error';
    }

    // Check PostgreSQL
    let pgStatus = 'unknown';
    let pgInfo = {};
    try {
      await pgPool.query('SELECT 1');
      pgStatus = 'connected';
      pgInfo.totalConnections = pgPool.totalCount;
      pgInfo.idleConnections = pgPool.idleCount;
      pgInfo.waitingConnections = pgPool.waitingCount;
    } catch (e) {
      pgStatus = 'error';
    }

    res.json({
      status: redisStatus === 'connected' && pgStatus === 'connected' ? 'healthy' : 'degraded',
      services: {
        redis: { status: redisStatus, ...redisInfo },
        postgres: { status: pgStatus, ...pgInfo },
      },
      trie: trie.getStats(),
      aggregation: aggregationService.getStats(),
      circuits: getCircuitStatus(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ event: 'status_error', error: error.message });
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

// Initialize and load data
async function initialize() {
  const startTime = Date.now();

  try {
    logger.info({ event: 'initialization_started' });

    // Wait for database connections
    await redis.ping();
    logger.info({ event: 'redis_connected' });

    await pgPool.query('SELECT 1');
    logger.info({ event: 'postgres_connected' });

    // Load phrases from database into trie
    const result = await pgPool.query(
      'SELECT phrase, count FROM phrase_counts WHERE is_filtered = false ORDER BY count DESC LIMIT 100000'
    );

    logger.info({ event: 'loading_phrases', count: result.rows.length });

    for (const row of result.rows) {
      trie.insert(row.phrase, parseInt(row.count));
    }

    const stats = trie.getStats();
    const durationMs = Date.now() - startTime;

    logger.info({
      event: 'trie_initialized',
      phraseCount: stats.phraseCount,
      nodeCount: stats.nodeCount,
      durationMs,
    });

    auditLogger.logTrieRebuild('startup', stats.phraseCount, durationMs);

    // Update metrics
    updateTrieMetrics(stats);

    // Start aggregation service
    aggregationService.start();
    logger.info({ event: 'aggregation_service_started' });
  } catch (error) {
    logger.error({
      event: 'initialization_error',
      error: error.message,
      stack: error.stack,
    });
    logger.info({ event: 'continuing_with_empty_trie' });
  }
}

// Graceful shutdown
async function shutdown() {
  logger.info({ event: 'shutdown_started' });

  aggregationService.stop();
  cleanupIdempotency();

  try {
    await redis.quit();
    logger.info({ event: 'redis_disconnected' });
  } catch (error) {
    logger.error({ event: 'redis_disconnect_error', error: error.message });
  }

  try {
    await pgPool.end();
    logger.info({ event: 'postgres_disconnected' });
  } catch (error) {
    logger.error({ event: 'postgres_disconnect_error', error: error.message });
  }

  logger.info({ event: 'shutdown_complete' });
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Start server
app.listen(PORT, async () => {
  logger.info({
    event: 'server_started',
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development',
  });
  await initialize();
});

export { app, redis, pgPool };
