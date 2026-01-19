/**
 * Health monitoring for cache nodes
 *
 * This module provides comprehensive health monitoring capabilities for cache nodes:
 * - Periodic health checks to detect node failures
 * - Automatic node addition/removal from the consistent hash ring
 * - Integration with Prometheus metrics for observability
 * - Graceful rebalancing when nodes come online or go offline
 */

import type { ConsistentHashRing } from '../lib/consistent-hash.js';
import {
  clusterNodesHealthy,
  clusterNodesTotal,
  nodeHealthCheckFailures,
} from '../shared/metrics.js';
import {
  createLogger,
  logNodeHealthChange,
  logNodeAdded,
  logNodeRemoved,
} from '../shared/logger.js';
import { removeCircuitBreaker } from '../shared/circuit-breaker.js';
import type { RebalanceManager } from '../shared/rebalance.js';
import type { NodeStatusInfo, NodeRequestFn } from './types.js';

const logger = createLogger({ component: 'health-monitor' });

/**
 * Configuration options for the health monitor.
 *
 * @description Settings that control how the health monitor operates,
 * including which nodes to monitor and how frequently.
 *
 * @property {string[]} nodes - Array of cache node URLs to monitor
 * @property {number} healthCheckInterval - Milliseconds between health check cycles
 * @property {boolean} gracefulRebalance - Whether to trigger rebalancing when nodes change
 */
export interface HealthMonitorConfig {
  nodes: string[];
  healthCheckInterval: number;
  gracefulRebalance: boolean;
}

/**
 * Health monitor interface for cache nodes.
 *
 * @description Defines the public API for the health monitor, including
 * methods for checking node health and accessing status information.
 *
 * @property {Map<string, NodeStatusInfo>} nodeStatus - Current status of all monitored nodes
 * @property {Function} checkNodeHealth - Check health of a single node
 * @property {Function} checkAllNodesHealth - Check health of all configured nodes
 * @property {Function} startPeriodicHealthCheck - Start the background health check timer
 * @property {Function} getHealthyNodesCount - Get the count of currently healthy nodes
 */
export interface HealthMonitor {
  nodeStatus: Map<string, NodeStatusInfo>;
  checkNodeHealth: (nodeUrl: string) => Promise<NodeStatusInfo>;
  checkAllNodesHealth: () => Promise<NodeStatusInfo[]>;
  startPeriodicHealthCheck: () => NodeJS.Timeout;
  getHealthyNodesCount: () => number;
}

/**
 * Creates a health monitor for cache nodes.
 *
 * @description Factory function that creates a health monitor instance. The monitor
 * periodically checks the health of all configured cache nodes and updates the
 * consistent hash ring accordingly. Nodes that fail 3 consecutive health checks
 * are automatically removed from the ring.
 *
 * @param {HealthMonitorConfig} config - Configuration for the health monitor
 * @param {string[]} config.nodes - Array of cache node URLs to monitor
 * @param {number} config.healthCheckInterval - Milliseconds between health check cycles
 * @param {boolean} config.gracefulRebalance - Whether to trigger rebalancing on node changes
 * @param {ConsistentHashRing} ring - The consistent hash ring to update based on node health
 * @param {NodeRequestFn} nodeRequest - Function for making HTTP requests to nodes
 * @param {RebalanceManager} rebalanceManager - Manager for handling key migration during rebalancing
 * @returns {HealthMonitor} The configured health monitor instance
 *
 * @example
 * ```typescript
 * const monitor = createHealthMonitor(
 *   { nodes: ['http://localhost:3001'], healthCheckInterval: 5000, gracefulRebalance: true },
 *   ring,
 *   nodeRequest,
 *   rebalanceManager
 * );
 * await monitor.checkAllNodesHealth();
 * monitor.startPeriodicHealthCheck();
 * ```
 */
export function createHealthMonitor(
  config: HealthMonitorConfig,
  ring: ConsistentHashRing,
  nodeRequest: NodeRequestFn,
  rebalanceManager: RebalanceManager
): HealthMonitor {
  const { nodes, healthCheckInterval, gracefulRebalance } = config;
  const nodeStatus = new Map<string, NodeStatusInfo>();

  /**
   * Checks the health of a single cache node.
   *
   * @description Sends a health check request to the specified node and updates
   * its status accordingly. If the node is healthy but not in the ring, it will
   * be added. If the node fails 3 consecutive checks, it will be removed from
   * the ring.
   *
   * @param {string} nodeUrl - The URL of the node to check (e.g., 'http://localhost:3001')
   * @returns {Promise<NodeStatusInfo>} The updated status information for the node
   */
  async function checkNodeHealth(nodeUrl: string): Promise<NodeStatusInfo> {
    const result = await nodeRequest(nodeUrl, '/health');

    if (result.success) {
      const data = result.data as {
        nodeId?: string;
        uptime?: number;
        cache?: unknown;
      };
      const wasUnhealthy = nodeStatus.get(nodeUrl)?.healthy === false;
      const status: NodeStatusInfo = {
        url: nodeUrl,
        healthy: true,
        nodeId: data.nodeId,
        uptime: data.uptime,
        cache: data.cache,
        lastCheck: new Date().toISOString(),
        consecutiveFailures: 0,
      };
      nodeStatus.set(nodeUrl, status);

      // Add to ring if not already present
      if (!ring.getAllNodes().includes(nodeUrl)) {
        ring.addNode(nodeUrl);
        logNodeAdded(nodeUrl);

        // Trigger graceful rebalancing if enabled
        if (gracefulRebalance && ring.getAllNodes().length > 1) {
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
      const status: NodeStatusInfo = {
        url: nodeUrl,
        healthy: false,
        error: result.error as string,
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

    return nodeStatus.get(nodeUrl)!;
  }

  /**
   * Checks the health of all configured nodes.
   *
   * @description Performs health checks on all nodes in parallel and updates
   * the Prometheus metrics for cluster health status.
   *
   * @returns {Promise<NodeStatusInfo[]>} Array of status information for all nodes
   */
  async function checkAllNodesHealth(): Promise<NodeStatusInfo[]> {
    const results = await Promise.all(nodes.map(checkNodeHealth));

    // Update cluster metrics
    const healthy = results.filter((r) => r.healthy).length;
    clusterNodesHealthy.set(healthy);
    clusterNodesTotal.set(nodes.length);

    return results;
  }

  /**
   * Starts periodic health checks.
   *
   * @description Creates an interval timer that runs health checks on all nodes
   * at the configured interval. Returns the timer handle for cleanup.
   *
   * @returns {NodeJS.Timeout} The interval timer handle (use clearInterval to stop)
   */
  function startPeriodicHealthCheck(): NodeJS.Timeout {
    return setInterval(checkAllNodesHealth, healthCheckInterval);
  }

  /**
   * Gets the count of currently healthy nodes.
   *
   * @description Returns the number of nodes that passed their most recent
   * health check. Useful for determining cluster availability.
   *
   * @returns {number} The count of healthy nodes
   */
  function getHealthyNodesCount(): number {
    return Array.from(nodeStatus.values()).filter((n) => n.healthy).length;
  }

  return {
    nodeStatus,
    checkNodeHealth,
    checkAllNodesHealth,
    startPeriodicHealthCheck,
    getHealthyNodesCount,
  };
}
