/**
 * Admin routes for cluster management
 *
 * This module provides administrative endpoints for managing the cache cluster:
 * - Node management (add/remove nodes dynamically)
 * - Health check triggers
 * - Rebalancing operations for graceful node transitions
 * - Circuit breaker management
 * - Snapshot triggers for persistence
 *
 * All admin routes (except /admin/config) require authentication via admin key.
 */

import { Router } from 'express';
import type { ConsistentHashRing } from '../lib/consistent-hash.js';
import { requireAdminKey, getAdminConfig } from '../shared/auth.js';
import {
  removeCircuitBreaker,
  getAllCircuitBreakerStatus,
  resetAllCircuitBreakers,
} from '../shared/circuit-breaker.js';
import { createLogger, logAdminOperation } from '../shared/logger.js';
import type { RebalanceManager } from '../shared/rebalance.js';
import type { HealthMonitor } from './health-monitor.js';
import type { NodeRequestFn, NodeStatusInfo } from './types.js';

const logger = createLogger({ component: 'admin-routes' });

/**
 * Configuration for admin routes.
 *
 * @description Settings that control administrative behavior.
 *
 * @property {boolean} gracefulRebalance - Whether to migrate keys during node removal
 */
export interface AdminRoutesConfig {
  gracefulRebalance: boolean;
}

/**
 * Creates an Express router for administrative operations.
 *
 * @description Factory function that creates a router with endpoints for cluster
 * administration. Most endpoints require admin authentication and are intended
 * for operational use by system administrators.
 *
 * Supported routes:
 * - GET /admin/config - Get admin configuration (no auth required)
 * - POST /admin/node - Add a new node to the cluster
 * - DELETE /admin/node - Remove a node from the cluster
 * - POST /admin/health-check - Force immediate health check of all nodes
 * - POST /admin/rebalance - Manually trigger rebalancing
 * - GET /admin/rebalance/analyze - Analyze impact of adding a node
 * - POST /admin/snapshot - Force snapshot on all nodes
 * - GET /admin/circuit-breakers - Get circuit breaker status
 * - POST /admin/circuit-breakers/reset - Reset all circuit breakers
 *
 * @param {AdminRoutesConfig} config - Configuration with rebalance settings
 * @param {ConsistentHashRing} ring - The consistent hash ring for node management
 * @param {string[]} nodes - Mutable array of configured node URLs
 * @param {Map<string, NodeStatusInfo>} nodeStatus - Map of node URLs to their health status
 * @param {NodeRequestFn} nodeRequest - Function for making HTTP requests to cache nodes
 * @param {HealthMonitor} healthMonitor - Health monitor for triggering health checks
 * @param {RebalanceManager} rebalanceManager - Manager for handling key migration
 * @returns {Router} An Express router configured with admin routes
 *
 * @example
 * ```typescript
 * const adminRouter = createAdminRouter(
 *   { gracefulRebalance: true },
 *   ring,
 *   nodes,
 *   nodeStatus,
 *   nodeRequest,
 *   healthMonitor,
 *   rebalanceManager
 * );
 * app.use(adminRouter);
 * ```
 */
export function createAdminRouter(
  config: AdminRoutesConfig,
  ring: ConsistentHashRing,
  nodes: string[],
  nodeStatus: Map<string, NodeStatusInfo>,
  nodeRequest: NodeRequestFn,
  healthMonitor: HealthMonitor,
  rebalanceManager: RebalanceManager
): Router {
  const router = Router();
  const { gracefulRebalance } = config;

  /**
   * GET /admin/config - Get admin configuration
   *
   * @description Returns the current admin configuration including whether
   * admin authentication is required. Does not require authentication.
   *
   * @returns 200 with admin configuration object
   */
  router.get('/admin/config', (_req, res) => {
    res.json(getAdminConfig());
  });

  /**
   * POST /admin/node - Add a new node to the cluster
   *
   * @description Dynamically adds a new cache node to the cluster. The node
   * is added to the configuration and an immediate health check is performed
   * to determine if it should be added to the hash ring.
   *
   * @body {string} url - The URL of the node to add (e.g., 'http://localhost:3004')
   * @returns 200 with success message and node health status, 400 if URL missing
   */
  router.post('/admin/node', requireAdminKey, async (req, res) => {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    if (!nodes.includes(url)) {
      nodes.push(url);
    }

    const status = await healthMonitor.checkNodeHealth(url);

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
   *
   * @description Removes a cache node from the cluster. If graceful rebalancing
   * is enabled, keys are migrated to other nodes before removal. The node is
   * removed from the configuration, hash ring, and circuit breaker registry.
   *
   * @body {string} url - The URL of the node to remove
   * @body {boolean} [graceful=true] - Whether to perform graceful rebalancing
   * @returns 200 with success message and remaining nodes, 400 if URL missing
   */
  router.delete('/admin/node', requireAdminKey, async (req, res) => {
    const { url, graceful = true } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    // Graceful rebalancing before removal
    if (graceful && gracefulRebalance && ring.getAllNodes().includes(url)) {
      try {
        const rebalanceResult = await rebalanceManager.handleNodeRemoved(url);
        logger.info({ url, ...rebalanceResult }, 'graceful_removal_complete');
      } catch (error: unknown) {
        logger.error(
          { url, error: (error as Error).message },
          'graceful_removal_failed'
        );
      }
    }

    const index = nodes.indexOf(url);
    if (index > -1) {
      nodes.splice(index, 1);
    }

    ring.removeNode(url);
    removeCircuitBreaker(url);
    nodeStatus.delete(url);

    logAdminOperation('remove_node', { url, graceful });

    res.json({
      message: 'Node removed',
      remainingNodes: nodes,
    });
  });

  /**
   * POST /admin/health-check - Force health check of all nodes
   *
   * @description Triggers an immediate health check of all configured nodes,
   * bypassing the normal periodic check interval. Useful for verifying cluster
   * state after changes.
   *
   * @returns 200 with health check results for all nodes
   */
  router.post('/admin/health-check', requireAdminKey, async (_req, res) => {
    const results = await healthMonitor.checkAllNodesHealth();

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
   *
   * @description Manually triggers a rebalancing operation to migrate keys
   * when a node is added or removed. Normally rebalancing happens automatically,
   * but this endpoint allows manual control.
   *
   * @body {string} targetNode - The URL of the node being added or removed
   * @body {string} action - Either 'add' or 'remove'
   * @returns 200 with rebalance results, 400 if parameters missing or invalid
   */
  router.post('/admin/rebalance', requireAdminKey, async (req, res) => {
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
   *
   * @description Analyzes how adding a new node would affect the key distribution
   * without actually performing the operation. Useful for capacity planning.
   *
   * @query {string} targetNode - The URL of the node to analyze
   * @returns 200 with impact analysis, 400 if targetNode missing
   */
  router.get('/admin/rebalance/analyze', requireAdminKey, async (req, res) => {
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
   *
   * @description Triggers an immediate snapshot (persistence) operation on all
   * active cache nodes. Useful for ensuring data durability before maintenance.
   *
   * @returns 200 with snapshot results from each node
   */
  router.post('/admin/snapshot', requireAdminKey, async (_req, res) => {
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
   *
   * @description Returns the current state of all circuit breakers in the system.
   * Circuit breakers protect against cascading failures by temporarily stopping
   * requests to failing nodes.
   *
   * @returns 200 with circuit breaker states and timestamp
   */
  router.get('/admin/circuit-breakers', requireAdminKey, (_req, res) => {
    res.json({
      circuitBreakers: getAllCircuitBreakerStatus(),
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * POST /admin/circuit-breakers/reset - Reset all circuit breakers
   *
   * @description Resets all circuit breakers to their closed (normal) state.
   * Use this after resolving issues that caused circuit breakers to open.
   *
   * @returns 200 with success message and timestamp
   */
  router.post('/admin/circuit-breakers/reset', requireAdminKey, (_req, res) => {
    resetAllCircuitBreakers();

    logAdminOperation('reset_circuit_breakers', {});

    res.json({
      message: 'All circuit breakers reset',
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
