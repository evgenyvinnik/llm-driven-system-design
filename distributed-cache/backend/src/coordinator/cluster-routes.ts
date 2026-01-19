/**
 * Cluster information and statistics routes
 *
 * This module provides Express routes for accessing cluster-wide information:
 * - Cluster info with node status and configuration
 * - Aggregated statistics from all cache nodes
 * - Key distribution analysis
 * - Hot keys aggregation across the cluster
 */

import { Router } from 'express';
import type { ConsistentHashRing } from '../lib/consistent-hash.js';
import { getAllCircuitBreakerStatus } from '../shared/circuit-breaker.js';
import type { RebalanceManager } from '../shared/rebalance.js';
import type {
  NodeRequestFn,
  NodeStats,
  HotKey,
  NodeHotKeysResult,
  NodeStatusInfo,
} from './types.js';

/**
 * Configuration for cluster routes.
 *
 * @description Settings needed for cluster information endpoints.
 *
 * @property {number | string} port - The port the coordinator is listening on
 * @property {number} virtualNodes - Number of virtual nodes per physical node in the hash ring
 */
export interface ClusterRoutesConfig {
  port: number | string;
  virtualNodes: number;
}

/**
 * Creates an Express router for cluster information and statistics.
 *
 * @description Factory function that creates a router providing comprehensive
 * cluster information endpoints. These routes aggregate data from all nodes
 * and provide insights into cluster health, performance, and key distribution.
 *
 * Supported routes:
 * - GET /cluster/info - Cluster overview with node status and configuration
 * - GET /cluster/stats - Aggregated cache statistics from all nodes
 * - GET /cluster/locate/:key - Find which node owns a specific key
 * - POST /cluster/distribution - Analyze key distribution across nodes
 * - GET /cluster/hot-keys - Aggregate hot keys from all nodes
 *
 * @param {ClusterRoutesConfig} config - Configuration with port and virtual nodes settings
 * @param {ConsistentHashRing} ring - The consistent hash ring for key routing
 * @param {Map<string, NodeStatusInfo>} nodeStatus - Map of node URLs to their health status
 * @param {NodeRequestFn} nodeRequest - Function for making HTTP requests to cache nodes
 * @param {RebalanceManager} rebalanceManager - Manager for tracking rebalance operations
 * @returns {Router} An Express router configured with cluster information routes
 *
 * @example
 * ```typescript
 * const clusterRouter = createClusterRouter(
 *   { port: 3000, virtualNodes: 150 },
 *   ring,
 *   nodeStatus,
 *   nodeRequest,
 *   rebalanceManager
 * );
 * app.use(clusterRouter);
 * ```
 */
export function createClusterRouter(
  config: ClusterRoutesConfig,
  ring: ConsistentHashRing,
  nodeStatus: Map<string, NodeStatusInfo>,
  nodeRequest: NodeRequestFn,
  rebalanceManager: RebalanceManager
): Router {
  const router = Router();
  const { port, virtualNodes } = config;

  /**
   * GET /cluster/info - Cluster info
   *
   * @description Returns comprehensive information about the cluster including
   * coordinator status, ring configuration, node health, circuit breaker states,
   * and rebalance status.
   *
   * @returns 200 with cluster information object
   */
  router.get('/cluster/info', (_req, res) => {
    res.json({
      coordinator: {
        port,
        uptime: process.uptime(),
      },
      ring: {
        virtualNodes,
        activeNodes: ring.getAllNodes(),
      },
      nodes: Array.from(nodeStatus.values()),
      circuitBreakers: getAllCircuitBreakerStatus(),
      rebalance: rebalanceManager.getStatus(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /cluster/stats - Cluster stats - aggregate from all nodes
   *
   * @description Fetches statistics from all active nodes and aggregates them
   * into cluster-wide totals. Includes hit/miss counts, set/delete operations,
   * evictions, total entries, memory usage, and hit rate.
   *
   * @returns 200 with aggregated statistics and per-node breakdown
   */
  router.get('/cluster/stats', async (_req, res) => {
    const activeNodes = ring.getAllNodes() as string[];
    const statsPromises = activeNodes.map(async (nodeUrl: string) => {
      const result = await nodeRequest(nodeUrl, '/stats');
      return result.success
        ? ({ nodeUrl, ...(result.data as object) } as NodeStats)
        : null;
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
   * GET /cluster/locate/:key - Check which node a key belongs to
   *
   * @description Uses the consistent hash ring to determine which node is
   * responsible for a given key. Useful for debugging key distribution.
   *
   * @param {string} key - The cache key to locate (URL parameter)
   * @returns 200 with node URL and list of all nodes, 503 if no nodes available
   */
  router.get('/cluster/locate/:key', (req, res) => {
    const { key } = req.params;

    try {
      const nodeUrl = ring.getNode(key);
      if (!nodeUrl) {
        return res.status(503).json({ error: 'No healthy nodes available' });
      }
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
   * POST /cluster/distribution - Get key distribution across nodes
   *
   * @description Analyzes how a set of keys would be distributed across the
   * cluster nodes. Useful for understanding load balancing and identifying
   * potential hot spots.
   *
   * @body {string[]} keys - Array of cache keys to analyze
   * @returns 200 with distribution counts and percentages per node, 400 if keys is not an array
   */
  router.post('/cluster/distribution', (req, res) => {
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
   * GET /cluster/hot-keys - Get hot keys across the cluster
   *
   * @description Aggregates hot key information from all active nodes.
   * Hot keys are frequently accessed keys that may require special handling
   * to prevent becoming performance bottlenecks.
   *
   * @returns 200 with per-node hot keys and aggregated list with node attribution
   */
  router.get('/cluster/hot-keys', async (_req, res) => {
    const activeNodes = ring.getAllNodes() as string[];
    const hotKeysPromises = activeNodes.map(
      async (nodeUrl: string): Promise<NodeHotKeysResult> => {
        const result = await nodeRequest(nodeUrl, '/hot-keys');
        const data = result.data as { hotKeys?: HotKey[] } | undefined;
        return result.success
          ? { nodeUrl, hotKeys: data?.hotKeys || [] }
          : { nodeUrl, hotKeys: [] };
      }
    );

    const allHotKeys = await Promise.all(hotKeysPromises);

    res.json({
      nodes: allHotKeys,
      aggregated: allHotKeys.flatMap((n) =>
        (n.hotKeys || []).map((hk: HotKey) => ({ ...hk, node: n.nodeUrl }))
      ),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
