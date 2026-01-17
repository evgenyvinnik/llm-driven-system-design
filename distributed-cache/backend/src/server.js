/**
 * Cache Node - An individual cache server in the distributed cluster
 *
 * Features:
 * - LRU eviction with TTL support
 * - HTTP API for cache operations
 * - Health check endpoint
 * - Stats reporting for monitoring
 */

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { LRUCache } from './lib/lru-cache.js';

// Configuration from environment
const PORT = process.env.PORT || 3001;
const NODE_ID = process.env.NODE_ID || `node-${PORT}`;
const MAX_SIZE = parseInt(process.env.MAX_SIZE || '10000', 10);
const MAX_MEMORY_MB = parseInt(process.env.MAX_MEMORY_MB || '100', 10);
const DEFAULT_TTL = parseInt(process.env.DEFAULT_TTL || '0', 10);

// Initialize cache
const cache = new LRUCache({
  maxSize: MAX_SIZE,
  maxMemoryMB: MAX_MEMORY_MB,
  defaultTTL: DEFAULT_TTL,
});

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

// ======================
// Health & Info Routes
// ======================

/**
 * Health check endpoint
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    nodeId: NODE_ID,
    port: PORT,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
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
    timestamp: new Date().toISOString(),
  });
});

// ======================
// Cache Operations
// ======================

/**
 * GET /cache/:key - Get a value from cache
 */
app.get('/cache/:key', (req, res) => {
  const { key } = req.params;
  const value = cache.get(key);

  if (value === undefined) {
    return res.status(404).json({
      error: 'Key not found',
      key,
    });
  }

  res.json({
    key,
    value,
    ttl: cache.ttl(key),
  });
});

/**
 * POST /cache/:key - Set a value in cache
 * Body: { value: any, ttl?: number }
 */
app.post('/cache/:key', (req, res) => {
  const { key } = req.params;
  const { value, ttl = 0 } = req.body;

  if (value === undefined) {
    return res.status(400).json({
      error: 'Value is required',
    });
  }

  cache.set(key, value, ttl);

  res.status(201).json({
    key,
    ttl: cache.ttl(key),
    message: 'Value set successfully',
  });
});

/**
 * PUT /cache/:key - Update a value in cache (same as POST)
 */
app.put('/cache/:key', (req, res) => {
  const { key } = req.params;
  const { value, ttl = 0 } = req.body;

  if (value === undefined) {
    return res.status(400).json({
      error: 'Value is required',
    });
  }

  cache.set(key, value, ttl);

  res.json({
    key,
    ttl: cache.ttl(key),
    message: 'Value updated successfully',
  });
});

/**
 * DELETE /cache/:key - Delete a key from cache
 */
app.delete('/cache/:key', (req, res) => {
  const { key } = req.params;
  const deleted = cache.delete(key);

  if (!deleted) {
    return res.status(404).json({
      error: 'Key not found',
      key,
    });
  }

  res.json({
    key,
    message: 'Key deleted successfully',
  });
});

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
    const value = cache.get(key);
    if (value !== undefined) {
      results[key] = value;
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

  res.json({
    message: 'Cache flushed',
    keysCleared: statsBefore.size,
  });
});

// ======================
// Error Handling
// ======================

app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({
    error: 'Internal server error',
    message: err.message,
  });
});

// ======================
// Start Server
// ======================

const server = app.listen(PORT, () => {
  console.log(`
==============================================
  Cache Node Started
==============================================
  Node ID:    ${NODE_ID}
  Port:       ${PORT}
  Max Size:   ${MAX_SIZE} entries
  Max Memory: ${MAX_MEMORY_MB} MB
  Default TTL: ${DEFAULT_TTL} seconds (0 = no expiration)
==============================================
`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  cache.destroy();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  cache.destroy();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
