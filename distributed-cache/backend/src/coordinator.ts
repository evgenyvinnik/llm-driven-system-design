/**
 * Cache Coordinator - Routes requests to appropriate cache nodes using consistent hashing
 *
 * Features:
 * - Consistent hashing for key distribution
 * - Health monitoring of cache nodes
 * - Automatic node discovery and removal
 * - Cluster-wide statistics aggregation
 * - Admin API for cluster management (with authentication)
 * - Circuit breakers for node communication
 * - Graceful rebalancing on node changes
 * - Prometheus metrics endpoint
 */

import express from 'express';
import cors from 'cors';
import { ConsistentHashRing } from './lib/consistent-hash.js';
import {
  getMetrics,
  getContentType,
  clusterNodesHealthy,
  clusterNodesTotal,
  nodeHealthCheckFailures,
} from './shared/metrics.js';
import {
  createLogger,
  createHttpLogger,
  logNodeHealthChange,
  logNodeAdded,
  logNodeRemoved,
  logAdminOperation,
} from './shared/logger.js';
import { requireAdminKey, getAdminConfig } from './shared/auth.js';
import {
  removeCircuitBreaker,
  getAllCircuitBreakerStatus,
  resetAllCircuitBreakers,
} from './shared/circuit-breaker.js';
import { createRebalanceManager } from './shared/rebalance.js';

// Define interface for node stats
interface NodeStats {
  nodeUrl: string;
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  size: number;
  memoryMB: string;
  hotKeys?: Array<{ key: string; count: number }>;
}

// Define interface for hot key
interface HotKey {
  key: string;
  count: number;
  node?: string;
}

// Define interface for node hot keys result
interface NodeHotKeysResult {
  nodeUrl: string;
  hotKeys: HotKey[];
}

// Define interface for keys result
interface KeysResult {
  nodeUrl: string;
  keys: string[];
}

// Configuration
const PORT = process.env.PORT || 3000;
const NODES = (
  process.env.CACHE_NODES ||
  'http://localhost:3001,http://localhost:3002,http://localhost:3003'
).split(',');
const HEALTH_CHECK_INTERVAL = parseInt(
  process.env.HEALTH_CHECK_INTERVAL || '5000',
  10
);
const VIRTUAL_NODES = parseInt(process.env.VIRTUAL_NODES || '150', 10);
const GRACEFUL_REBALANCE =
  (process.env.GRACEFUL_REBALANCE || 'true') === 'true';

// Create logger
const logger = createLogger({ component: 'coordinator' });

// Initialize consistent hash ring
const ring = new ConsistentHashRing(VIRTUAL_NODES);

// Node status tracking
const nodeStatus = new Map();

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
 * Make an HTTP request to a cache node with circuit breaker
 */
async function nodeRequest(nodeUrl: string, path: string, options: RequestInit = {}) {
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
      const error = await response
        .json()
        .catch(() => ({ error: 'Unknown error' }));
      return { success: false, status: response.status, error };
    }

    const data = await response.json();
    return { success: true, data, status: response.status };
  } catch (error: unknown) {
    clearTimeout(timeout);
    return { success: false, error: (error as Error).message };
  }
}

// Initialize rebalance manager
const rebalanceManager = createRebalanceManager(ring, nodeRequest);

/**
 * Check health of a single node
 */
async function checkNodeHealth(nodeUrl: string) {
  const result = await nodeRequest(nodeUrl, '/health');

  if (result.success) {
    const wasUnhealthy = nodeStatus.get(nodeUrl)?.healthy === false;
    const status = {
      url: nodeUrl,
      healthy: true,
      nodeId: result.data.nodeId,
      uptime: result.data.uptime,
      cache: result.data.cache,
      lastCheck: new Date().toISOString(),
      consecutiveFailures: 0,
    };
    nodeStatus.set(nodeUrl, status);

    // Add to ring if not already present
    if (!ring.getAllNodes().includes(nodeUrl)) {
      ring.addNode(nodeUrl);
      logNodeAdded(nodeUrl);

      // Trigger graceful rebalancing if enabled
      if (GRACEFUL_REBALANCE && ring.getAllNodes().length > 1) {
        rebalanceManager.handleNodeAdded(nodeUrl).catch((err) => {
          logger.error(
            { nodeUrl, error: err.message },
            'rebalance_after_node_add_failed'
          );
        });
      }
    }

    // Log recovery
    if (wasUnhealthy) {
      logNodeHealthChange(nodeUrl, true, 'recovered');
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
    nodeHealthCheckFailures.labels(nodeUrl).inc();

    // Remove from ring after 3 consecutive failures
    if (status.consecutiveFailures >= 3 && ring.getAllNodes().includes(nodeUrl)) {
      ring.removeNode(nodeUrl);
      removeCircuitBreaker(nodeUrl);
      logNodeRemoved(nodeUrl, `${status.consecutiveFailures} consecutive failures`);
    }
  }

  return nodeStatus.get(nodeUrl);
}

/**
 * Check health of all nodes
 */
async function checkAllNodesHealth() {
  const results = await Promise.all(NODES.map(checkNodeHealth));

  // Update cluster metrics
  const healthy = results.filter((r) => r.healthy).length;
  clusterNodesHealthy.set(healthy);
  clusterNodesTotal.set(NODES.length);

  return results;
}

/**
 * Get node for a key
 */
function getNodeForKey(key: string) {
  const nodeUrl = ring.getNode(key);
  if (!nodeUrl) {
    throw new Error('No healthy nodes available');
  }
  return nodeUrl;
}

// ======================
// Health & Metrics Routes
// ======================

/**
 * Coordinator health check
 */
app.get('/health', (_req, res) => {
  const healthyNodes = Array.from(nodeStatus.values()).filter(
    (n) => n.healthy
  ).length;

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
 * Prometheus metrics endpoint
 */
app.get('/metrics', async (_req, res) => {
  try {
    res.set('Content-Type', getContentType());
    res.end(await getMetrics());
  } catch (error: unknown) {
    logger.error({ error: (error as Error).message }, 'metrics_error');
    res.status(500).end((error as Error).message);
  }
});

/**
 * Cluster info
 */
app.get('/cluster/info', (_req, res) => {
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
    circuitBreakers: getAllCircuitBreakerStatus(),
    rebalance: rebalanceManager.getStatus(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Cluster stats - aggregate from all nodes
 */
app.get('/cluster/stats', async (_req, res) => {
  const activeNodes = ring.getAllNodes() as string[];
  const statsPromises = activeNodes.map(async (nodeUrl: string) => {
    const result = await nodeRequest(nodeUrl, '/stats');
    return result.success ? ({ nodeUrl, ...result.data } as NodeStats) : null;
  });

  const allStats = (await Promise.all(statsPromises)).filter(
    (s): s is NodeStats => s !== null
  );

  // Aggregate stats
  const totalHits = allStats.reduce((sum, s) => sum + s.hits, 0);
  const totalMisses = allStats.reduce((sum, s) => sum + s.misses, 0);
  const totalOps = totalHits + totalMisses;

  const aggregated = {
    totalNodes: allStats.length,
    totalHits,
    totalMisses,
    totalSets: allStats.reduce((sum, s) => sum + s.sets, 0),
    totalDeletes: allStats.reduce((sum, s) => sum + s.deletes, 0),
    totalEvictions: allStats.reduce((sum, s) => sum + s.evictions, 0),
    totalSize: allStats.reduce((sum, s) => sum + s.size, 0),
    totalMemoryMB: allStats
      .reduce((sum, s) => sum + parseFloat(s.memoryMB), 0)
      .toFixed(2),
    hotKeys: allStats.flatMap((s) =>
      (s.hotKeys || []).map((hk: HotKey) => ({ ...hk, node: s.nodeUrl }))
    ),
    perNode: allStats,
    overallHitRate:
      totalOps > 0 ? ((totalHits / totalOps) * 100).toFixed(2) : '0.00',
  };

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
  } catch (error: unknown) {
    res.status(503).json({
      error: (error as Error).message,
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
  const result: Record<string, { count: number; percentage: string }> = {};

  for (const [nodeUrl, count] of distribution) {
    result[nodeUrl as string] = {
      count: count as number,
      percentage: (((count as number) / keys.length) * 100).toFixed(2),
    };
  }

  res.json({
    totalKeys: keys.length,
    distribution: result,
  });
});

/**
 * Get hot keys across the cluster
 */
app.get('/cluster/hot-keys', async (_req, res) => {
  const activeNodes = ring.getAllNodes() as string[];
  const hotKeysPromises = activeNodes.map(async (nodeUrl: string): Promise<NodeHotKeysResult> => {
    const result = await nodeRequest(nodeUrl, '/hot-keys');
    return result.success
      ? { nodeUrl, ...result.data }
      : { nodeUrl, hotKeys: [] };
  });

  const allHotKeys = await Promise.all(hotKeysPromises);

  res.json({
    nodes: allHotKeys,
    aggregated: allHotKeys.flatMap((n) =>
      (n.hotKeys || []).map((hk: HotKey) => ({ ...hk, node: n.nodeUrl }))
    ),
    timestamp: new Date().toISOString(),
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
  } catch (error: unknown) {
    res.status(503).json({ error: (error as Error).message });
  }
});

/**
 * POST /cache/:key - Set a value (routed via consistent hashing)
 */
app.post('/cache/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    const result = await nodeRequest(
      nodeUrl,
      `/cache/${encodeURIComponent(key)}`,
      {
        method: 'POST',
        body: JSON.stringify(req.body),
      }
    );

    if (result.success) {
      res.status(201).json({
        ...result.data,
        _routing: { nodeUrl },
      });
    } else {
      res.status(result.status || 500).json(result.error);
    }
  } catch (error: unknown) {
    res.status(503).json({ error: (error as Error).message });
  }
});

/**
 * PUT /cache/:key - Update a value
 */
app.put('/cache/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    const result = await nodeRequest(
      nodeUrl,
      `/cache/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        body: JSON.stringify(req.body),
      }
    );

    if (result.success) {
      res.json({
        ...result.data,
        _routing: { nodeUrl },
      });
    } else {
      res.status(result.status || 500).json(result.error);
    }
  } catch (error: unknown) {
    res.status(503).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /cache/:key - Delete a key
 */
app.delete('/cache/:key', async (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    const result = await nodeRequest(
      nodeUrl,
      `/cache/${encodeURIComponent(key)}`,
      {
        method: 'DELETE',
      }
    );

    if (result.success) {
      res.json({
        ...result.data,
        _routing: { nodeUrl },
      });
    } else {
      res.status(result.status || 500).json(result.error);
    }
  } catch (error: unknown) {
    res.status(503).json({ error: (error as Error).message });
  }
});

/**
 * POST /cache/:key/incr - Increment a value
 */
app.post('/cache/:key/incr', async (req, res) => {
  const { key } = req.params;

  try {
    const nodeUrl = getNodeForKey(key);
    const result = await nodeRequest(
      nodeUrl,
      `/cache/${encodeURIComponent(key)}/incr`,
      {
        method: 'POST',
        body: JSON.stringify(req.body),
      }
    );

    if (result.success) {
      res.json({
        ...result.data,
        _routing: { nodeUrl },
      });
    } else {
      res.status(result.status || 500).json(result.error);
    }
  } catch (error: unknown) {
    res.status(503).json({ error: (error as Error).message });
  }
});

/**
 * GET /keys - List all keys from all nodes
 */
app.get('/keys', async (req, res) => {
  const pattern = (req.query.pattern as string) || '*';
  const activeNodes = ring.getAllNodes() as string[];

  const keysPromises = activeNodes.map(async (nodeUrl: string): Promise<KeysResult> => {
    const result = await nodeRequest(
      nodeUrl,
      `/keys?pattern=${encodeURIComponent(pattern)}`
    );
    return result.success
      ? { nodeUrl, keys: result.data.keys }
      : { nodeUrl, keys: [] };
  });

  const allKeysResults = await Promise.all(keysPromises);

  const allKeys: string[] = [];
  const perNode: Record<string, number> = {};

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
 * POST /flush - Flush all nodes (requires admin auth)
 */
app.post('/flush', requireAdminKey, async (_req, res) => {
  const activeNodes = ring.getAllNodes() as string[];

  const flushPromises = activeNodes.map(async (nodeUrl: string) => {
    const result = await nodeRequest(nodeUrl, '/flush', { method: 'POST' });
    return { nodeUrl, success: result.success };
  });

  const results = await Promise.all(flushPromises);

  logAdminOperation('flush', { nodes: activeNodes.length });

  res.json({
    message: 'Flush command sent to all nodes',
    results,
  });
});

// ======================
// Admin Operations (Protected)
// ======================

/**
 * GET /admin/config - Get admin configuration
 */
app.get('/admin/config', (_req, res) => {
  res.json(getAdminConfig());
});

/**
 * POST /admin/node - Add a new node to the cluster
 */
app.post('/admin/node', requireAdminKey, async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!NODES.includes(url)) {
    NODES.push(url);
  }

  const status = await checkNodeHealth(url);

  logAdminOperation('add_node', { url, healthy: status.healthy });

  res.json({
    message: status.healthy
      ? 'Node added successfully'
      : 'Node added but is not healthy',
    status,
  });
});

/**
 * DELETE /admin/node - Remove a node from the cluster
 */
app.delete('/admin/node', requireAdminKey, async (req, res) => {
  const { url, graceful = true } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  // Graceful rebalancing before removal
  if (graceful && GRACEFUL_REBALANCE && ring.getAllNodes().includes(url)) {
    try {
      const rebalanceResult = await rebalanceManager.handleNodeRemoved(url);
      logger.info(
        { url, ...rebalanceResult },
        'graceful_removal_complete'
      );
    } catch (error: unknown) {
      logger.error(
        { url, error: (error as Error).message },
        'graceful_removal_failed'
      );
    }
  }

  const index = NODES.indexOf(url);
  if (index > -1) {
    NODES.splice(index, 1);
  }

  ring.removeNode(url);
  removeCircuitBreaker(url);
  nodeStatus.delete(url);

  logAdminOperation('remove_node', { url, graceful });

  res.json({
    message: 'Node removed',
    remainingNodes: NODES,
  });
});

/**
 * POST /admin/health-check - Force health check of all nodes
 */
app.post('/admin/health-check', requireAdminKey, async (_req, res) => {
  const results = await checkAllNodesHealth();

  logAdminOperation('force_health_check', {
    total: results.length,
    healthy: results.filter((r) => r.healthy).length,
  });

  res.json({
    message: 'Health check completed',
    results,
  });
});

/**
 * POST /admin/rebalance - Trigger rebalancing
 */
app.post('/admin/rebalance', requireAdminKey, async (req, res) => {
  const { targetNode, action } = req.body;

  if (!targetNode || !action) {
    return res.status(400).json({
      error: 'targetNode and action (add/remove) are required',
    });
  }

  let result;
  if (action === 'add') {
    result = await rebalanceManager.handleNodeAdded(targetNode);
  } else if (action === 'remove') {
    result = await rebalanceManager.handleNodeRemoved(targetNode);
  } else {
    return res.status(400).json({
      error: 'Invalid action. Use "add" or "remove"',
    });
  }

  logAdminOperation('rebalance', { targetNode, action, ...result });

  res.json({
    message: 'Rebalance completed',
    ...result,
  });
});

/**
 * GET /admin/rebalance/analyze - Analyze impact of adding a node
 */
app.get('/admin/rebalance/analyze', requireAdminKey, async (req, res) => {
  const targetNode = req.query.targetNode as string | undefined;

  if (!targetNode) {
    return res.status(400).json({
      error: 'targetNode query parameter is required',
    });
  }

  const impact = await rebalanceManager.analyzeAddNodeImpact(targetNode);

  res.json({
    targetNode,
    impact,
  });
});

/**
 * POST /admin/snapshot - Force snapshot on all nodes
 */
app.post('/admin/snapshot', requireAdminKey, async (_req, res) => {
  const activeNodes = ring.getAllNodes() as string[];

  const snapshotPromises = activeNodes.map(async (nodeUrl: string) => {
    const result = await nodeRequest(nodeUrl, '/snapshot', { method: 'POST' });
    return { nodeUrl, success: result.success, data: result.data };
  });

  const results = await Promise.all(snapshotPromises);

  logAdminOperation('force_snapshot', { nodes: activeNodes.length });

  res.json({
    message: 'Snapshot command sent to all nodes',
    results,
  });
});

/**
 * GET /admin/circuit-breakers - Get circuit breaker status
 */
app.get('/admin/circuit-breakers', requireAdminKey, (_req, res) => {
  res.json({
    circuitBreakers: getAllCircuitBreakerStatus(),
    timestamp: new Date().toISOString(),
  });
});

/**
 * POST /admin/circuit-breakers/reset - Reset all circuit breakers
 */
app.post('/admin/circuit-breakers/reset', requireAdminKey, (_req, res) => {
  resetAllCircuitBreakers();

  logAdminOperation('reset_circuit_breakers', {});

  res.json({
    message: 'All circuit breakers reset',
    timestamp: new Date().toISOString(),
  });
});

// ======================
// Error Handling
// ======================

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ error: err.message, stack: err.stack }, 'unhandled_error');
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
  logger.info({}, 'initial_health_check_completed');
});

// Periodic health checks
setInterval(checkAllNodesHealth, HEALTH_CHECK_INTERVAL);

// Start server
const server = app.listen(PORT, () => {
  logger.info(
    {
      port: PORT,
      nodes: NODES,
      virtualNodes: VIRTUAL_NODES,
      healthCheckInterval: HEALTH_CHECK_INTERVAL,
      gracefulRebalance: GRACEFUL_REBALANCE,
    },
    'coordinator_started'
  );

  console.log(`
==============================================
  Cache Coordinator Started
==============================================
  Port:           ${PORT}
  Cache Nodes:    ${NODES.join(', ')}
  Virtual Nodes:  ${VIRTUAL_NODES}
  Health Check:   Every ${HEALTH_CHECK_INTERVAL}ms
  Graceful Rebalance: ${GRACEFUL_REBALANCE}
  Metrics:        http://localhost:${PORT}/metrics
==============================================
`);
});

// Graceful shutdown
async function shutdown(signal: string) {
  logger.info({ signal }, 'shutdown_initiated');

  server.close(() => {
    logger.info({}, 'server_closed');
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

export default app;
