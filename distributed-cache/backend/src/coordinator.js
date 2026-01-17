/**
 * Cache Coordinator - Routes requests to appropriate cache nodes using consistent hashing
 *
 * Features:
 * - Consistent hashing for key distribution
 * - Health monitoring of cache nodes
 * - Automatic node discovery and removal
 * - Cluster-wide statistics aggregation
 * - Admin API for cluster management
 */

import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import { ConsistentHashRing } from './lib/consistent-hash.js';

// Configuration
const PORT = process.env.PORT || 3000;
const NODES = (process.env.CACHE_NODES || 'http://localhost:3001,http://localhost:3002,http://localhost:3003').split(',');
const HEALTH_CHECK_INTERVAL = parseInt(process.env.HEALTH_CHECK_INTERVAL || '5000', 10);
const VIRTUAL_NODES = parseInt(process.env.VIRTUAL_NODES || '150', 10);

// Initialize consistent hash ring
const ring = new ConsistentHashRing(VIRTUAL_NODES);

// Node status tracking
const nodeStatus = new Map();

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(morgan('combined'));

// ======================
// Helper Functions
// ======================

/**
 * Make an HTTP request to a cache node
 */
async function nodeRequest(nodeUrl, path, options = {}) {
  const url = `${nodeUrl}${path}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Unknown error' }));
      return { success: false, status: response.status, error };
    }

    const data = await response.json();
    return { success: true, data, status: response.status };
  } catch (error) {
    clearTimeout(timeout);
    return { success: false, error: error.message };
  }
}

/**
 * Check health of a single node
 */
async function checkNodeHealth(nodeUrl) {
  const result = await nodeRequest(nodeUrl, '/health');

  if (result.success) {
    const status = {
      url: nodeUrl,
      healthy: true,
      nodeId: result.data.nodeId,
      uptime: result.data.uptime,
      lastCheck: new Date().toISOString(),
      consecutiveFailures: 0,
    };
    nodeStatus.set(nodeUrl, status);

    // Add to ring if not already present
    if (!ring.getAllNodes().includes(nodeUrl)) {
      ring.addNode(nodeUrl);
      console.log(`Node ${nodeUrl} added to ring`);
    }
  } else {
    const existing = nodeStatus.get(nodeUrl) || { consecutiveFailures: 0 };
    const status = {
      url: nodeUrl,
      healthy: false,
      error: result.error,
      lastCheck: new Date().toISOString(),
      consecutiveFailures: existing.consecutiveFailures + 1,
    };
    nodeStatus.set(nodeUrl, status);

    // Remove from ring after 3 consecutive failures
    if (status.consecutiveFailures >= 3 && ring.getAllNodes().includes(nodeUrl)) {
      ring.removeNode(nodeUrl);
      console.log(`Node ${nodeUrl} removed from ring after ${status.consecutiveFailures} failures`);
    }
  }

  return nodeStatus.get(nodeUrl);
}

/**
 * Check health of all nodes
 */
async function checkAllNodesHealth() {
  const results = await Promise.all(NODES.map(checkNodeHealth));
  return results;
}

/**
 * Get node for a key
 */
function getNodeForKey(key) {
  const nodeUrl = ring.getNode(key);
  if (!nodeUrl) {
    throw new Error('No healthy nodes available');
  }
  return nodeUrl;
}

// ======================
// Health & Info Routes
// ======================

/**
 * Coordinator health check
 */
app.get('/health', (req, res) => {
  const healthyNodes = Array.from(nodeStatus.values()).filter((n) => n.healthy).length;

  res.json({
    status: healthyNodes > 0 ? 'healthy' : 'degraded',
    coordinator: true,
    port: PORT,
    totalNodes: NODES.length,
    healthyNodes,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Cluster info
 */
app.get('/cluster/info', (req, res) => {
  res.json({
    coordinator: {
      port: PORT,
      uptime: process.uptime(),
    },
    ring: {
      virtualNodes: VIRTUAL_NODES,
      activeNodes: ring.getAllNodes(),
    },
    nodes: Array.from(nodeStatus.values()),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Cluster stats - aggregate from all nodes
 */
app.get('/cluster/stats', async (req, res) => {
  const activeNodes = ring.getAllNodes();
  const statsPromises = activeNodes.map(async (nodeUrl) => {
    const result = await nodeRequest(nodeUrl, '/stats');
    return result.success ? { nodeUrl, ...result.data } : null;
  });

  const allStats = (await Promise.all(statsPromises)).filter(Boolean);

  // Aggregate stats
  const aggregated = {
    totalNodes: allStats.length,
    totalHits: allStats.reduce((sum, s) => sum + s.hits, 0),
    totalMisses: allStats.reduce((sum, s) => sum + s.misses, 0),
    totalSets: allStats.reduce((sum, s) => sum + s.sets, 0),
    totalDeletes: allStats.reduce((sum, s) => sum + s.deletes, 0),
    totalEvictions: allStats.reduce((sum, s) => sum + s.evictions, 0),
    totalSize: allStats.reduce((sum, s) => sum + s.size, 0),
    totalMemoryMB: allStats.reduce((sum, s) => sum + parseFloat(s.memoryMB), 0).toFixed(2),
    perNode: allStats,
  };

  const totalOps = aggregated.totalHits + aggregated.totalMisses;
  aggregated.overallHitRate = totalOps > 0 ? ((aggregated.totalHits / totalOps) * 100).toFixed(2) : '0.00';

  res.json({
    ...aggregated,
    timestamp: new Date().toISOString(),
  });
});

/**
 * Check which node a key belongs to
 */
app.get('/cluster/locate/:key', (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    res.json({
      key,
      nodeUrl,
      allNodes: ring.getAllNodes(),
    });
  } catch (error) {
    res.status(503).json({
      error: error.message,
    });
  }
});

/**
 * Get key distribution across nodes
 */
app.post('/cluster/distribution', (req, res) => {
  const { keys } = req.body;

  if (!Array.isArray(keys)) {
    return res.status(400).json({
      error: 'Keys must be an array',
    });
  }

  const distribution = ring.getDistribution(keys);
  const result = {};

  for (const [nodeUrl, count] of distribution) {
    result[nodeUrl] = {
      count,
      percentage: ((count / keys.length) * 100).toFixed(2),
    };
  }

  res.json({
    totalKeys: keys.length,
    distribution: result,
  });
});

// ======================
// Proxied Cache Operations
// ======================

/**
 * GET /cache/:key - Get a value (routed via consistent hashing)
 */
app.get('/cache/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    const result = await nodeRequest(nodeUrl, `/cache/${encodeURIComponent(key)}`);

    if (result.success) {
      res.json({
        ...result.data,
        _routing: { nodeUrl },
      });
    } else {
      res.status(result.status || 500).json(result.error);
    }
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

/**
 * POST /cache/:key - Set a value (routed via consistent hashing)
 */
app.post('/cache/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    const result = await nodeRequest(nodeUrl, `/cache/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });

    if (result.success) {
      res.status(201).json({
        ...result.data,
        _routing: { nodeUrl },
      });
    } else {
      res.status(result.status || 500).json(result.error);
    }
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

/**
 * PUT /cache/:key - Update a value
 */
app.put('/cache/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    const result = await nodeRequest(nodeUrl, `/cache/${encodeURIComponent(key)}`, {
      method: 'PUT',
      body: JSON.stringify(req.body),
    });

    if (result.success) {
      res.json({
        ...result.data,
        _routing: { nodeUrl },
      });
    } else {
      res.status(result.status || 500).json(result.error);
    }
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

/**
 * DELETE /cache/:key - Delete a key
 */
app.delete('/cache/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    const result = await nodeRequest(nodeUrl, `/cache/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });

    if (result.success) {
      res.json({
        ...result.data,
        _routing: { nodeUrl },
      });
    } else {
      res.status(result.status || 500).json(result.error);
    }
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

/**
 * POST /cache/:key/incr - Increment a value
 */
app.post('/cache/:key/incr', async (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    const result = await nodeRequest(nodeUrl, `/cache/${encodeURIComponent(key)}/incr`, {
      method: 'POST',
      body: JSON.stringify(req.body),
    });

    if (result.success) {
      res.json({
        ...result.data,
        _routing: { nodeUrl },
      });
    } else {
      res.status(result.status || 500).json(result.error);
    }
  } catch (error) {
    res.status(503).json({ error: error.message });
  }
});

/**
 * GET /keys - List all keys from all nodes
 */
app.get('/keys', async (req, res) => {
  const { pattern = '*' } = req.query;
  const activeNodes = ring.getAllNodes();

  const keysPromises = activeNodes.map(async (nodeUrl) => {
    const result = await nodeRequest(nodeUrl, `/keys?pattern=${encodeURIComponent(pattern)}`);
    return result.success ? { nodeUrl, keys: result.data.keys } : { nodeUrl, keys: [] };
  });

  const allKeysResults = await Promise.all(keysPromises);

  const allKeys = [];
  const perNode = {};

  for (const result of allKeysResults) {
    perNode[result.nodeUrl] = result.keys.length;
    allKeys.push(...result.keys);
  }

  res.json({
    pattern,
    totalCount: allKeys.length,
    perNode,
    keys: allKeys.slice(0, 1000),
  });
});

/**
 * POST /flush - Flush all nodes
 */
app.post('/flush', async (req, res) => {
  const activeNodes = ring.getAllNodes();

  const flushPromises = activeNodes.map(async (nodeUrl) => {
    const result = await nodeRequest(nodeUrl, '/flush', { method: 'POST' });
    return { nodeUrl, success: result.success };
  });

  const results = await Promise.all(flushPromises);

  res.json({
    message: 'Flush command sent to all nodes',
    results,
  });
});

// ======================
// Admin Operations
// ======================

/**
 * POST /admin/node - Add a new node to the cluster
 */
app.post('/admin/node', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!NODES.includes(url)) {
    NODES.push(url);
  }

  const status = await checkNodeHealth(url);

  res.json({
    message: status.healthy ? 'Node added successfully' : 'Node added but is not healthy',
    status,
  });
});

/**
 * DELETE /admin/node - Remove a node from the cluster
 */
app.delete('/admin/node', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  const index = NODES.indexOf(url);
  if (index > -1) {
    NODES.splice(index, 1);
  }

  ring.removeNode(url);
  nodeStatus.delete(url);

  res.json({
    message: 'Node removed',
    remainingNodes: NODES,
  });
});

/**
 * POST /admin/health-check - Force health check of all nodes
 */
app.post('/admin/health-check', async (req, res) => {
  const results = await checkAllNodesHealth();
  res.json({
    message: 'Health check completed',
    results,
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
// Startup
// ======================

// Initial health check
checkAllNodesHealth().then(() => {
  console.log('Initial health check completed');
});

// Periodic health checks
setInterval(checkAllNodesHealth, HEALTH_CHECK_INTERVAL);

// Start server
const server = app.listen(PORT, () => {
  console.log(`
==============================================
  Cache Coordinator Started
==============================================
  Port:           ${PORT}
  Cache Nodes:    ${NODES.join(', ')}
  Virtual Nodes:  ${VIRTUAL_NODES}
  Health Check:   Every ${HEALTH_CHECK_INTERVAL}ms
==============================================
`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export default app;
