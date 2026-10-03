import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import IORedis from 'ioredis';
import pg from 'pg';

import { Trie } from './data-structures/trie.js';
import { SuggestionService } from './services/suggestion-service.js';
import { RankingService } from './services/ranking-service.js';
import { AggregationService } from './services/aggregation-service.js';
import { TrieSyncService } from './services/trie-sync-service.js';
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
import { cleanup as cleanupIdempotency } from './shared/idempotency.js';

const app = express();
const PORT = process.env.PORT || 3000;

// Startup retries back off 1s, 2s, 4s ... up to this
const INIT_RETRY_MAX_MS = 30000;
// Exit even if a shutdown step hangs
const SHUTDOWN_TIMEOUT_MS = 10000;

/**
 * Express 'trust proxy' from TRUST_PROXY: a hop count, 'true', or addresses/subnets such as
 * 'loopback'. Unset, req.ip is the socket address and client-sent X-Forwarded-For is ignored,
 * which keeps rate-limit keys unspoofable when no proxy is in front.
 */
function parseTrustProxy(value: string | undefined): boolean | number | string | undefined {
  if (!value || value === 'false') return undefined;
  if (value === 'true') return true;
  return /^\d+$/.test(value) ? Number(value) : value;
}

const trustProxy = parseTrustProxy(process.env.TRUST_PROXY);
if (trustProxy !== undefined) {
  app.set('trust proxy', trustProxy);
}

// ETags come only from shared/cache-headers.ts, which hashes stable content and leaves them off
// errors and no-store responses; Express's automatic body-hash ETag would add one to those too
app.set('etag', false);

// The UI calls /api through the Vite proxy (same origin), so CORS only matters for pages that call
// the API directly. Allow just the configured origins (comma-separated CORS_ORIGINS), not every origin.
const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

// Middleware
app.use(cors({ origin: corsOrigins }));
app.use(express.json());
app.use(httpLogger); // Structured request logging
app.use(globalRateLimiter); // Global rate limiting

// Database connections
const Redis = IORedis.default || IORedis;
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  retryStrategy: (times: number) => Math.min(times * 100, 3000),
  maxRetriesPerRequest: 3,
});

// ioredis reconnects on its own; log the first error of each outage rather than every retry
let redisErrorLogged = false;
let redisWasReadyBefore = false;
redis.on('error', (err: Error) => {
  if (redisErrorLogged) return;
  redisErrorLogged = true;
  logger.error({ event: 'redis_error', error: err.message });
});
redis.on('ready', () => {
  if (redisErrorLogged) {
    logger.info({ event: 'redis_reconnected' });
  }
  // On every reconnect (not only after a logged error: a quick restart may not emit one),
  // re-mirror filtered_phrases. Admin filter changes skip the Redis blocked set while it is
  // down, and a restarted Redis without persistence has lost it. The first connection is
  // covered by aggregationService.start() / initialize().
  if (redisWasReadyBefore && trieLoaded) void aggregationService.syncBlockedPhrases();
  redisWasReadyBefore = true;
  redisErrorLogged = false;
});

const pgPool = new pg.Pool({
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'typeahead',
  password: process.env.PG_PASSWORD || 'typeahead_password',
  database: process.env.PG_DATABASE || 'typeahead',
  max: 20,
  // Fail fast when Postgres is unreachable instead of hanging startup retries and probes
  connectionTimeoutMillis: 5000,
});

// An idle pooled client emits 'error' when its connection drops (Postgres restart,
// pg_terminate_backend). Unhandled, that event crashes the process and the trie with it.
pgPool.on('error', (err: Error) => {
  logger.error({ event: 'pg_idle_client_error', error: err.message });
});

// Initialize services
const trie = new Trie(10); // Top 10 suggestions per node
const rankingService = new RankingService(redis);
const suggestionService = new SuggestionService(trie, redis, rankingService);
const aggregationService = new AggregationService(redis, pgPool, trie);
// Keeps this instance's trie in step with writes made by other instances (dev:server1/2/3)
const trieSync = new TrieSyncService(
  pgPool,
  redis,
  trie,
  suggestionService,
  parseInt(process.env.TRIE_SYNC_INTERVAL_MS || '5000')
);
aggregationService.setChangeListener(() => trieSync.notifyChanged());

// Set once the startup load from Postgres has filled the trie; readiness waits for it
let trieLoaded = false;
// Database time taken just before the startup load; the trie sync starts from it
let syncWatermark: { text: string; ms: number } | null = null;
let shuttingDown = false;

/**
 * PING Redis, failing at once while the client is disconnected. ioredis would otherwise queue
 * the command through its reconnect retries, holding a probe open for several seconds.
 */
async function pingRedis(): Promise<string> {
  if (redis.status !== 'ready') {
    throw new Error(`Redis not connected (status: ${redis.status})`);
  }
  return redis.ping();
}

// Make services available to routes
app.set('redis', redis);
app.set('pgPool', pgPool);
app.set('trie', trie);
app.set('suggestionService', suggestionService);
app.set('rankingService', rankingService);
app.set('aggregationService', aggregationService);
app.set('trieSync', trieSync);
app.set('logger', logger);
app.set('auditLogger', auditLogger);

// Until the trie is loaded every prefix answers [], so keep those answers out of HTTP caches
app.use((_req: Request, res: Response, next: NextFunction) => {
  if (!trieLoaded) res.locals.noStore = true;
  next();
});

// Routes
app.use('/api/v1/suggestions', suggestionRoutes);
app.use('/api/v1/analytics', analyticsRoutes);
app.use('/api/v1/admin', adminRoutes);

interface HealthCheck {
  status: string;
  loaded?: boolean;
  phraseCount?: number;
  nodeCount?: number;
  error?: string;
}

interface RedisInfo {
  memory?: string;
}

interface PgInfo {
  totalConnections?: number;
  idleConnections?: number;
  waitingConnections?: number;
}

/**
 * Prometheus metrics endpoint
 * WHY: Metrics enable SLO monitoring, capacity planning, and ranking optimization
 */
app.get('/metrics', async (_req: Request, res: Response) => {
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
    logger.error({ event: 'metrics_error', error: (error as Error).message });
    res.status(500).end();
  }
});

/**
 * Basic liveness probe
 */
app.get('/health', async (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Comprehensive readiness probe
 * WHY: Readiness probes ensure traffic only goes to healthy instances
 */
app.get('/health/ready', async (_req: Request, res: Response) => {
  const checks: Record<string, HealthCheck> = {
    trie: { status: 'unknown' },
    redis: { status: 'unknown' },
    postgres: { status: 'unknown' },
  };

  // Check trie is loaded: not ready (503) until the startup load has finished with phrases,
  // so a load balancer never routes to an instance that would answer every prefix with []
  try {
    const stats = trie.getStats();
    const ready = trieLoaded && stats.phraseCount > 0;
    checks.trie = {
      status: ready ? 'healthy' : 'unhealthy',
      loaded: trieLoaded,
      phraseCount: stats.phraseCount,
      nodeCount: stats.nodeCount,
      ...(ready ? {} : { error: trieLoaded ? 'Trie is empty' : 'Trie is still loading' }),
    };
  } catch (error) {
    checks.trie = { status: 'unhealthy', error: (error as Error).message };
  }

  // Check Redis connectivity
  try {
    const pong = await pingRedis();
    checks.redis = { status: pong === 'PONG' ? 'healthy' : 'unhealthy' };
  } catch (error) {
    checks.redis = { status: 'unhealthy', error: (error as Error).message };
  }

  // Check PostgreSQL connectivity
  try {
    await pgPool.query('SELECT 1');
    checks.postgres = { status: 'healthy' };
  } catch (error) {
    checks.postgres = { status: 'unhealthy', error: (error as Error).message };
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
app.get('/health/circuits', async (_req: Request, res: Response) => {
  const circuits = getCircuitStatus();
  res.json({
    circuits,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Detailed status endpoint for debugging
 */
app.get('/status', async (_req: Request, res: Response) => {
  try {
    // Check Redis
    let redisStatus = 'unknown';
    const redisInfo: RedisInfo = {};
    try {
      const pong = await pingRedis();
      redisStatus = pong === 'PONG' ? 'connected' : 'error';
      const info = await redis.info('memory');
      const memMatch = info.match(/used_memory_human:([^\r\n]+)/);
      redisInfo.memory = memMatch ? memMatch[1] : 'unknown';
    } catch {
      redisStatus = 'error';
    }

    // Check PostgreSQL
    let pgStatus = 'unknown';
    const pgInfo: PgInfo = {};
    try {
      await pgPool.query('SELECT 1');
      pgStatus = 'connected';
      pgInfo.totalConnections = pgPool.totalCount;
      pgInfo.idleConnections = pgPool.idleCount;
      pgInfo.waitingConnections = pgPool.waitingCount;
    } catch {
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
      trieSync: trieSync.getStats(),
      circuits: getCircuitStatus(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error({ event: 'status_error', error: (error as Error).message });
    res.status(500).json({
      error: 'Internal server error',
    });
  }
});

// Final error handler: JSON instead of Express's default HTML page, which includes the stack
// trace outside production. Malformed JSON bodies reach it as 400s from express.json().
app.use(
  (
    err: Error & { status?: number; statusCode?: number; expose?: boolean },
    _req: Request,
    res: Response,
    next: NextFunction
  ) => {
    if (res.headersSent) {
      next(err);
      return;
    }

    const status = err.status ?? err.statusCode ?? 500;
    const httpStatus = status >= 400 && status < 600 ? status : 500;
    if (httpStatus >= 500) {
      logger.error({ event: 'unhandled_error', error: err.message, stack: err.stack });
    }

    res.status(httpStatus).json({
      error:
        httpStatus >= 500 ? 'Internal server error' : err.expose ? err.message : 'Bad request',
    });
  }
);

/**
 * Run a startup step until it succeeds, backing off 1s, 2s, 4s ... up to INIT_RETRY_MAX_MS.
 * Resolves false if shutdown begins first.
 */
async function retryUntilSuccess(step: string, fn: () => Promise<void>): Promise<boolean> {
  for (let attempt = 1; !shuttingDown; attempt++) {
    try {
      await fn();
      return true;
    } catch (error) {
      const retryInMs = Math.min(1000 * 2 ** (attempt - 1), INIT_RETRY_MAX_MS);
      logger.error({
        event: 'initialization_error',
        step,
        attempt,
        retryInMs,
        error: (error as Error).message,
      });
      await new Promise((resolve) => setTimeout(resolve, retryInMs));
    }
  }
  return false;
}

/**
 * Load phrases from Postgres into the trie. Needs only Postgres, not Redis.
 */
async function loadTrie(): Promise<void> {
  const startTime = Date.now();

  // Databases created before phrase_counts.changed_at existed (init.sql only runs on a fresh
  // volume) get the column here; the trie sync between instances polls it
  await pgPool.query(
    `ALTER TABLE phrase_counts ADD COLUMN IF NOT EXISTS changed_at TIMESTAMPTZ DEFAULT NOW();
     CREATE INDEX IF NOT EXISTS idx_phrase_changed_at ON phrase_counts(changed_at);`
  );

  // Read the clock before the load, so the sync re-reads anything written while it runs
  syncWatermark = await trieSync.currentDbTime();

  // last_updated (epoch ms) feeds the ranking's recency score
  const result = await pgPool.query(
    `SELECT phrase, count, EXTRACT(EPOCH FROM last_updated::timestamptz) * 1000 AS last_updated_ms
     FROM phrase_counts
     WHERE is_filtered = false
     ORDER BY count DESC
     LIMIT 100000`
  );
  logger.info({ event: 'postgres_connected' });
  logger.info({ event: 'loading_phrases', count: result.rows.length });

  for (const row of result.rows) {
    const lastUpdated = row.last_updated_ms === null ? undefined : Number(row.last_updated_ms);
    trie.insert(row.phrase, parseInt(row.count), lastUpdated);
  }

  const stats = trie.getStats();
  const durationMs = Date.now() - startTime;
  trieLoaded = true;

  logger.info({
    event: 'trie_initialized',
    phraseCount: stats.phraseCount,
    nodeCount: stats.nodeCount,
    durationMs,
  });

  auditLogger.logTrieRebuild('startup', stats.phraseCount, durationMs);

  // Update metrics
  updateTrieMetrics(stats);
}

// Initialize and load data. Each step retries until its dependency is reachable, so a
// Postgres/Redis that comes up after the API (e.g. right after docker-compose up) is picked up.
async function initialize(): Promise<void> {
  logger.info({ event: 'initialization_started' });

  if (!(await retryUntilSuccess('load_trie', loadTrie)) || shuttingDown) return;

  // Start aggregation once the trie is loaded. Flushes need only Postgres (the upsert checks
  // filtered_phrases itself), so a Redis outage doesn't leave logged searches unflushed.
  const redisWasReady = redis.status === 'ready';
  aggregationService.start();
  logger.info({ event: 'aggregation_service_started' });

  if (syncWatermark) {
    trieSync.start(syncWatermark);
    logger.info({ event: 'trie_sync_started', intervalMs: trieSync.getStats().intervalMs });
  }

  if (redisWasReady) {
    logger.info({ event: 'redis_connected' });
    return;
  }

  // start() mirrors filtered_phrases into the Redis blocked set and publishes trending; with
  // Redis down that failed, so redo it once Redis is reachable
  const redisReady = await retryUntilSuccess('redis', async () => {
    await pingRedis();
    logger.info({ event: 'redis_connected' });
  });
  if (!redisReady || shuttingDown) return;

  await aggregationService.syncBlockedPhrases();
  await aggregationService.aggregateTrendingWindows();
}

// Graceful shutdown
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ event: 'shutdown_started', signal });

  setTimeout(() => {
    logger.error({ event: 'shutdown_timeout', timeoutMs: SHUTDOWN_TIMEOUT_MS });
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();

  // Stop accepting new connections
  server.close();

  // The final flush writes to Postgres and Redis, so it must finish before they are closed
  await aggregationService.stop();
  await trieSync.stop();
  cleanupIdempotency();

  try {
    // QUIT would wait in the offline queue while Redis is unreachable
    if (redis.status === 'ready') {
      await redis.quit();
    } else {
      redis.disconnect();
    }
    logger.info({ event: 'redis_disconnected' });
  } catch (error) {
    logger.error({ event: 'redis_disconnect_error', error: (error as Error).message });
  }

  try {
    await pgPool.end();
    logger.info({ event: 'postgres_disconnected' });
  } catch (error) {
    logger.error({ event: 'postgres_disconnect_error', error: (error as Error).message });
  }

  logger.info({ event: 'shutdown_complete' });
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// Start server. It answers liveness right away; /health/ready reports 503 until the trie is loaded.
const server = app.listen(PORT, () => {
  logger.info({
    event: 'server_started',
    port: PORT,
    nodeEnv: process.env.NODE_ENV || 'development',
  });
  void initialize();
});

export { app, redis, pgPool };
