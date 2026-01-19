/**
 * Cache Coordinator - Routes requests to appropriate cache nodes using consistent hashing
 *
 * The coordinator is the central entry point for the distributed cache cluster.
 * It receives all client requests and routes them to the appropriate cache node
 * based on consistent hashing of the cache key.
 *
 * Features:
 * - Consistent hashing for even key distribution across nodes
 * - Health monitoring with automatic node removal after failures
 * - Automatic node discovery when new nodes come online
 * - Cluster-wide statistics aggregation from all nodes
 * - Admin API for cluster management (with authentication)
 * - Circuit breakers to prevent cascading failures
 * - Graceful rebalancing when nodes are added or removed
 * - Prometheus metrics endpoint for monitoring
 *
 * @module coordinator
 */

import express from 'express';
import cors from 'cors';
import { ConsistentHashRing } from '../lib/consistent-hash.js';
import { getMetrics, getContentType } from '../shared/metrics.js';
import { createLogger, createHttpLogger, logAdminOperation } from '../shared/logger.js';
import { requireAdminKey } from '../shared/auth.js';
import { createRebalanceManager } from '../shared/rebalance.js';

import { createNodeRequest } from './node-request.js';
import { createHealthMonitor } from './health-monitor.js';
import { createCacheRouter } from './routing.js';
import { createClusterRouter } from './cluster-routes.js';
import { createAdminRouter } from './admin-routes.js';

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

// Create node request function
const nodeRequest = createNodeRequest();

// Initialize rebalance manager
const rebalanceManager = createRebalanceManager(ring, nodeRequest);

// Initialize health monitor
const healthMonitor = createHealthMonitor(
  {
    nodes: NODES,
    healthCheckInterval: HEALTH_CHECK_INTERVAL,
    gracefulRebalance: GRACEFUL_REBALANCE,
  },
  ring,
  nodeRequest,
  rebalanceManager
);

// Initialize Express app
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(createHttpLogger());

// ======================
// Health & Metrics Routes
// ======================

/**
 * GET /health - Coordinator health check
 *
 * @description Returns the health status of the coordinator and summary
 * information about the cluster. Used by load balancers and monitoring
 * systems to determine if the coordinator is available.
 *
 * @returns {Object} Health status object with:
 *   - status: 'healthy' if at least one node is available, 'degraded' otherwise
 *   - coordinator: true (indicates this is the coordinator)
 *   - port: The port the coordinator is listening on
 *   - totalNodes: Total number of configured nodes
 *   - healthyNodes: Number of currently healthy nodes
 *   - uptime: Coordinator uptime in seconds
 *   - timestamp: ISO timestamp of the response
 */
app.get('/health', (_req, res) => {
  const healthyNodes = healthMonitor.getHealthyNodesCount();

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
 * GET /metrics - Prometheus metrics endpoint
 *
 * @description Exposes Prometheus-formatted metrics for monitoring.
 * Includes cache operation counts, latencies, node health status,
 * and other operational metrics.
 *
 * @returns Prometheus text format metrics
 * @throws 500 if metrics collection fails
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

// ======================
// Mount Routers
// ======================

// Cluster routes
app.use(
  createClusterRouter(
    { port: PORT, virtualNodes: VIRTUAL_NODES },
    ring,
    healthMonitor.nodeStatus,
    nodeRequest,
    rebalanceManager
  )
);

// Cache operation routes
app.use(createCacheRouter(ring, nodeRequest));

/**
 * POST /flush - Protected flush route
 *
 * @description Clears all data from all cache nodes. This is a destructive
 * operation that requires admin authentication. The route is defined here
 * rather than in the cache router to apply admin authentication.
 *
 * @returns {Object} Flush results from each node
 */
app.post('/flush', requireAdminKey, async (_req, res) => {
  logAdminOperation('flush', { nodes: ring.getAllNodes().length });
  // Forward to the cache router's flush handler
  const activeNodes = ring.getAllNodes() as string[];
  const flushPromises = activeNodes.map(async (nodeUrl: string) => {
    const result = await nodeRequest(nodeUrl, '/flush', { method: 'POST' });
    return { nodeUrl, success: result.success };
  });
  const results = await Promise.all(flushPromises);
  res.json({
    message: 'Flush command sent to all nodes',
    results,
  });
});

// Admin routes
app.use(
  createAdminRouter(
    { gracefulRebalance: GRACEFUL_REBALANCE },
    ring,
    NODES,
    healthMonitor.nodeStatus,
    nodeRequest,
    healthMonitor,
    rebalanceManager
  )
);

// ======================
// Error Handling
// ======================

/**
 * Global error handler middleware
 *
 * @description Catches unhandled errors from route handlers and returns
 * a consistent error response format. Logs errors for debugging.
 */
app.use(
  (
    err: Error,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction
  ) => {
    logger.error({ error: err.message, stack: err.stack }, 'unhandled_error');
    res.status(500).json({
      error: 'Internal server error',
      message: err.message,
    });
  }
);

// ======================
// Startup
// ======================

// Initial health check
healthMonitor.checkAllNodesHealth().then(() => {
  logger.info({}, 'initial_health_check_completed');
});

// Periodic health checks
healthMonitor.startPeriodicHealthCheck();

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

/**
 * Graceful shutdown handler
 *
 * @description Handles SIGTERM and SIGINT signals to perform a clean shutdown.
 * Closes the HTTP server and waits for in-flight requests to complete.
 * Forces exit after 10 seconds if shutdown doesn't complete.
 *
 * @param {string} signal - The signal that triggered shutdown ('SIGTERM' or 'SIGINT')
 */
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
