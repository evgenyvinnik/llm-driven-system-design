/**
 * Cache Node - An individual cache server in the distributed cluster
 *
 * Features:
 * - LRU eviction with TTL support
 * - HTTP API for cache operations
 * - Health check endpoint
 * - Prometheus metrics endpoint
 * - Structured JSON logging
 * - Snapshot persistence
 * - Hot key detection
 */

import express from 'express';
import cors from 'cors';
import { LRUCache } from './lib/lru-cache.js';
import {
  getMetrics,
  getContentType,
  updateCacheStats,
  recordOperation,
  HotKeyDetector,
  cacheHits,
  cacheMisses,
  cacheSets,
  cacheDeletes,
  cacheEvictions,
  cacheExpirations,
  cacheMemoryLimitBytes,
} from './shared/metrics.js';
import {
  createLogger,
  createHttpLogger,
  logCacheHit,
  logCacheMiss,
  logCacheSet,
  logCacheDelete,
  logEviction,
  logHotKeysDetected,
} from './shared/logger.js';
import { createPersistenceManager } from './shared/persistence.js';

// Configuration from environment
const PORT = process.env.PORT || 3001;
const NODE_ID = process.env.NODE_ID || `node-${PORT}`;
const MAX_SIZE = parseInt(process.env.MAX_SIZE || '10000', 10);
const MAX_MEMORY_MB = parseInt(process.env.MAX_MEMORY_MB || '100', 10);
const DEFAULT_TTL = parseInt(process.env.DEFAULT_TTL || '0', 10);

// Create logger
const logger = createLogger({ nodeId: NODE_ID });

// Initialize cache
const cache = new LRUCache({
  maxSize: MAX_SIZE,
  maxMemoryMB: MAX_MEMORY_MB,
  defaultTTL: DEFAULT_TTL,
});

// Initialize hot key detector
const hotKeyDetector = new HotKeyDetector(NODE_ID, {
  windowMs: 60000,
  threshold: 0.01, // 1% of traffic
});

// Initialize persistence manager
const persistence = createPersistenceManager(NODE_ID, cache);

// Set memory limit metric
cacheMemoryLimitBytes.labels(NODE_ID).set(MAX_MEMORY_MB * 1024 * 1024);

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(createHttpLogger());

// ======================
// Helper Functions
// ======================

/**
 * Measure operation duration and record metrics
 */
function measureOperation(operation, fn) {
  return async (req, res, next) => {
    const start = performance.now();
    try {
      await fn(req, res, next);
    } finally {
      const duration = performance.now() - start;
      recordOperation(NODE_ID, operation, duration);
    }
  };
}

/**
 * Update cache stats metrics periodically
 */
function updateMetrics() {
  const stats = cache.getStats();
  updateCacheStats(NODE_ID, stats);

  // Check for hot keys
  const hotKeys = hotKeyDetector.getHotKeys();
  if (hotKeys.length > 0) {
    logHotKeysDetected(hotKeys);
  }
}

// Update metrics every 5 seconds
setInterval(updateMetrics, 5000);

// ======================
// Health & Metrics Routes
// ======================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  const stats = cache.getStats();
  const memoryUsage = process.memoryUsage();

  res.json({
    status: 'healthy',
    nodeId: NODE_ID,
    port: PORT,
    uptime: process.uptime(),
    cache: {
      entries: stats.size,
      memoryMB: stats.memoryMB,
      hitRate: stats.hitRate,
    },
    process: {
      heapUsedMB: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2),
      heapTotalMB: (memoryUsage.heapTotal / 1024 / 1024).toFixed(2),
      rssMB: (memoryUsage.rss / 1024 / 1024).toFixed(2),
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * Prometheus metrics endpoint
 */
app.get('/metrics', async (req, res) => {
  try {
    // Update cache stats before returning metrics
    updateMetrics();

    res.set('Content-Type', getContentType());
    res.end(await getMetrics());
  } catch (error) {
    logger.error({ error: error.message }, 'metrics_error');
    res.status(500).end(error.message);
  }
});

/**
 * Node info endpoint
 */
app.get('/info', (req, res) => {
  res.json({
    nodeId: NODE_ID,
    port: PORT,
    config: {
      maxSize: MAX_SIZE,
      maxMemoryMB: MAX_MEMORY_MB,
      defaultTTL: DEFAULT_TTL,
    },
    stats: cache.getStats(),
    hotKeys: hotKeyDetector.getHotKeys(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Stats endpoint for monitoring
 */
app.get('/stats', (req, res) => {
  res.json({
    nodeId: NODE_ID,
    ...cache.getStats(),
    hotKeys: hotKeyDetector.getHotKeys(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Hot keys endpoint
 */
app.get('/hot-keys', (req, res) => {
  res.json({
    nodeId: NODE_ID,
    hotKeys: hotKeyDetector.getHotKeys(),
    windowMs: 60000,
    threshold: '1%',
    timestamp: new Date().toISOString(),
  });
});

// ======================
// Cache Operations
// ======================

/**
 * GET /cache/:key - Get a value from cache
 */
app.get(
  '/cache/:key',
  measureOperation('get', async (req, res) => {
    const { key } = req.params;

    // Record access for hot key detection
    hotKeyDetector.recordAccess(key);

    const value = cache.get(key);

    if (value === undefined) {
      cacheMisses.labels(NODE_ID).inc();
      logCacheMiss(key, 0);

      return res.status(404).json({
        error: 'Key not found',
        key,
      });
    }

    cacheHits.labels(NODE_ID).inc();
    logCacheHit(key, 0);

    res.json({
      key,
      value,
      ttl: cache.ttl(key),
    });
  })
);

/**
 * POST /cache/:key - Set a value in cache
 * Body: { value: any, ttl?: number }
 */
app.post(
  '/cache/:key',
  measureOperation('set', async (req, res) => {
    const { key } = req.params;
    const { value, ttl = 0 } = req.body;

    if (value === undefined) {
      return res.status(400).json({
        error: 'Value is required',
      });
    }

    cache.set(key, value, ttl);
    cacheSets.labels(NODE_ID).inc();
    logCacheSet(key, ttl, 0);

    res.status(201).json({
      key,
      ttl: cache.ttl(key),
      message: 'Value set successfully',
    });
  })
);

/**
 * PUT /cache/:key - Update a value in cache (same as POST)
 */
app.put(
  '/cache/:key',
  measureOperation('set', async (req, res) => {
    const { key } = req.params;
    const { value, ttl = 0 } = req.body;

    if (value === undefined) {
      return res.status(400).json({
        error: 'Value is required',
      });
    }

    cache.set(key, value, ttl);
    cacheSets.labels(NODE_ID).inc();
    logCacheSet(key, ttl, 0);

    res.json({
      key,
      ttl: cache.ttl(key),
      message: 'Value updated successfully',
    });
  })
);

/**
 * DELETE /cache/:key - Delete a key from cache
 */
app.delete(
  '/cache/:key',
  measureOperation('delete', async (req, res) => {
    const { key } = req.params;
    const deleted = cache.delete(key);

    if (!deleted) {
      return res.status(404).json({
        error: 'Key not found',
        key,
      });
    }

    cacheDeletes.labels(NODE_ID).inc();
    logCacheDelete(key);

    res.json({
      key,
      message: 'Key deleted successfully',
    });
  })
);

/**
 * GET /cache/:key/exists - Check if a key exists
 */
app.get('/cache/:key/exists', (req, res) => {
  const { key } = req.params;
  const exists = cache.has(key);

  res.json({
    key,
    exists,
  });
});

/**
 * GET /cache/:key/ttl - Get TTL for a key
 */
app.get('/cache/:key/ttl', (req, res) => {
  const { key } = req.params;
  const ttl = cache.ttl(key);

  if (ttl === -2) {
    return res.status(404).json({
      error: 'Key not found',
      key,
    });
  }

  res.json({
    key,
    ttl,
    hasExpiration: ttl !== -1,
  });
});

/**
 * POST /cache/:key/expire - Set TTL on an existing key
 * Body: { ttl: number }
 */
app.post('/cache/:key/expire', (req, res) => {
  const { key } = req.params;
  const { ttl } = req.body;

  if (ttl === undefined || typeof ttl !== 'number') {
    return res.status(400).json({
      error: 'TTL is required and must be a number',
    });
  }

  const success = cache.expire(key, ttl);

  if (!success) {
    return res.status(404).json({
      error: 'Key not found',
      key,
    });
  }

  res.json({
    key,
    ttl: cache.ttl(key),
    message: 'TTL set successfully',
  });
});

/**
 * POST /cache/:key/incr - Increment a numeric value
 * Body: { delta?: number }
 */
app.post('/cache/:key/incr', (req, res) => {
  const { key } = req.params;
  const { delta = 1 } = req.body;

  const result = cache.incr(key, delta);

  if (result === null) {
    return res.status(400).json({
      error: 'Value is not a number',
      key,
    });
  }

  res.json({
    key,
    value: result,
  });
});

/**
 * GET /cache/:key/info - Get detailed info about a key
 */
app.get('/cache/:key/info', (req, res) => {
  const { key } = req.params;
  const info = cache.getKeyInfo(key);

  if (!info) {
    return res.status(404).json({
      error: 'Key not found',
      key,
    });
  }

  res.json(info);
});

// ======================
// Bulk Operations
// ======================

/**
 * GET /keys - List all keys (with optional pattern)
 * Query: ?pattern=user:*
 */
app.get('/keys', (req, res) => {
  const { pattern = '*' } = req.query;
  const keys = cache.keys(pattern);

  res.json({
    pattern,
    count: keys.length,
    keys: keys.slice(0, 1000), // Limit to first 1000 keys
  });
});

/**
 * POST /mget - Get multiple keys
 * Body: { keys: string[] }
 */
app.post('/mget', (req, res) => {
  const { keys } = req.body;

  if (!Array.isArray(keys)) {
    return res.status(400).json({
      error: 'Keys must be an array',
    });
  }

  const results = {};
  for (const key of keys) {
    hotKeyDetector.recordAccess(key);
    const value = cache.get(key);
    if (value !== undefined) {
      results[key] = value;
      cacheHits.labels(NODE_ID).inc();
    } else {
      cacheMisses.labels(NODE_ID).inc();
    }
  }

  res.json({
    results,
    found: Object.keys(results).length,
    requested: keys.length,
  });
});

/**
 * POST /mset - Set multiple keys
 * Body: { entries: { key: string, value: any, ttl?: number }[] }
 */
app.post('/mset', (req, res) => {
  const { entries } = req.body;

  if (!Array.isArray(entries)) {
    return res.status(400).json({
      error: 'Entries must be an array',
    });
  }

  let set = 0;
  for (const entry of entries) {
    if (entry.key && entry.value !== undefined) {
      cache.set(entry.key, entry.value, entry.ttl || 0);
      cacheSets.labels(NODE_ID).inc();
      set++;
    }
  }

  res.json({
    set,
    requested: entries.length,
    message: 'Bulk set completed',
  });
});

/**
 * POST /flush - Clear all keys
 */
app.post('/flush', (req, res) => {
  const statsBefore = cache.getStats();
  cache.clear();

  logger.info({ keysCleared: statsBefore.size }, 'cache_flushed');

  res.json({
    message: 'Cache flushed',
    keysCleared: statsBefore.size,
  });
});

// ======================
// Persistence Endpoints
// ======================

/**
 * POST /snapshot - Force a snapshot
 */
app.post('/snapshot', async (req, res) => {
  try {
    const result = await persistence.forceSnapshot();
    res.json({
      message: 'Snapshot created',
      ...result,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'snapshot_failed');
    res.status(500).json({
      error: 'Snapshot failed',
      message: error.message,
    });
  }
});

/**
 * GET /snapshots - List available snapshots
 */
app.get('/snapshots', async (req, res) => {
  try {
    const snapshots = await persistence.listSnapshots();
    res.json({
      nodeId: NODE_ID,
      snapshots,
    });
  } catch (error) {
    logger.error({ error: error.message }, 'list_snapshots_failed');
    res.status(500).json({
      error: 'Failed to list snapshots',
      message: error.message,
    });
  }
});

// ======================
// Error Handling
// ======================

app.use((err, req, res, next) => {
  logger.error({ error: err.message, stack: err.stack }, 'unhandled_error');
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ======================
// Start Server
// ======================

async function start() {
  try {
    // Initialize persistence and load snapshot
    const loadResult = await persistence.initialize();
    if (loadResult.loaded) {
      logger.info(
        { entries: loadResult.entries, durationMs: loadResult.durationMs },
        'cache_warmed_from_snapshot'
      );
    }

    // Hook into cache eviction events
    const originalEvict = cache._evict.bind(cache);
    cache._evict = function () {
      const sizeBefore = this.cache.size;
      originalEvict();
      const evicted = sizeBefore - this.cache.size;
      if (evicted > 0) {
        cacheEvictions.labels(NODE_ID).inc(evicted);
      }
    };

    // Hook into cache expiration events
    const originalExpireCycle = cache._expireCycle.bind(cache);
    cache._expireCycle = function () {
      const expiredBefore = this.stats.expirations;
      originalExpireCycle();
      const expired = this.stats.expirations - expiredBefore;
      if (expired > 0) {
        cacheExpirations.labels(NODE_ID).inc(expired);
      }
    };

    const server = app.listen(PORT, () => {
      logger.info(
        {
          nodeId: NODE_ID,
          port: PORT,
          maxSize: MAX_SIZE,
          maxMemoryMB: MAX_MEMORY_MB,
          defaultTTL: DEFAULT_TTL,
        },
        'cache_node_started'
      );

      console.log(`
==============================================
  Cache Node Started
==============================================
  Node ID:    ${NODE_ID}
  Port:       ${PORT}
  Max Size:   ${MAX_SIZE} entries
  Max Memory: ${MAX_MEMORY_MB} MB
  Default TTL: ${DEFAULT_TTL} seconds (0 = no expiration)
  Metrics:    http://localhost:${PORT}/metrics
==============================================
`);
    });

    // Graceful shutdown
    async function shutdown(signal) {
      logger.info({ signal }, 'shutdown_initiated');

      // Stop accepting new connections
      server.close(async () => {
        logger.info({}, 'server_closed');

        // Cleanup resources
        await persistence.shutdown();
        hotKeyDetector.destroy();
        cache.destroy();

        logger.info({}, 'cleanup_complete');
        process.exit(0);
      });

      // Force shutdown after 10 seconds
      setTimeout(() => {
        logger.error({}, 'forced_shutdown');
        process.exit(1);
      }, 10000);
    }

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    logger.fatal({ error: error.message }, 'startup_failed');
    process.exit(1);
  }
}

start();

export default app;
