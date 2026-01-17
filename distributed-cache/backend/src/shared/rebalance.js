/**
 * Graceful Rebalancing Module
 *
 * Handles key migration when nodes are added or removed from the cluster.
 * Features:
 * - Gradual key migration to prevent cache storms
 * - Progress tracking and metrics
 * - Configurable migration rate
 */

import {
  rebalanceInProgress,
  rebalanceKeysMoved,
  rebalanceDuration,
} from './metrics.js';
import {
  logRebalanceStart,
  logRebalanceProgress,
  logRebalanceComplete,
  rebalanceLogger,
} from './logger.js';

// Configuration from environment
const REBALANCE_BATCH_SIZE = parseInt(
  process.env.REBALANCE_BATCH_SIZE || '100',
  10
);
const REBALANCE_DELAY_MS = parseInt(
  process.env.REBALANCE_DELAY_MS || '50',
  10
);
const REBALANCE_TIMEOUT_MS = parseInt(
  process.env.REBALANCE_TIMEOUT_MS || '300000',
  10
); // 5 minutes

/**
 * Rebalance Manager class
 * Handles gradual key migration during cluster changes
 */
export class RebalanceManager {
  constructor(ring, nodeRequestFn, options = {}) {
    this.ring = ring;
    this.nodeRequest = nodeRequestFn;
    this.batchSize = options.batchSize ?? REBALANCE_BATCH_SIZE;
    this.delayMs = options.delayMs ?? REBALANCE_DELAY_MS;
    this.timeoutMs = options.timeoutMs ?? REBALANCE_TIMEOUT_MS;

    this.isRebalancing = false;
    this.currentRebalance = null;
  }

  /**
   * Handle node addition - migrate keys to the new node
   * @param {string} newNodeUrl - URL of the newly added node
   * @returns {Promise<object>} Rebalance result
   */
  async handleNodeAdded(newNodeUrl) {
    if (this.isRebalancing) {
      rebalanceLogger.warn(
        { newNodeUrl },
        'rebalance_already_in_progress'
      );
      return { success: false, reason: 'Rebalance already in progress' };
    }

    const startTime = Date.now();
    this.isRebalancing = true;
    rebalanceInProgress.labels(newNodeUrl).set(1);

    try {
      // Get all existing nodes
      const existingNodes = this.ring
        .getAllNodes()
        .filter((n) => n !== newNodeUrl);

      if (existingNodes.length === 0) {
        rebalanceLogger.info({ newNodeUrl }, 'first_node_no_rebalance_needed');
        return { success: true, keysMoved: 0 };
      }

      // Collect keys from all existing nodes that should now belong to the new node
      const keysToMigrate = [];

      for (const sourceNode of existingNodes) {
        const keysResult = await this.nodeRequest(sourceNode, '/keys');
        if (keysResult.success && keysResult.data?.keys) {
          for (const key of keysResult.data.keys) {
            // Check if this key should now belong to the new node
            const targetNode = this.ring.getNode(key);
            if (targetNode === newNodeUrl) {
              keysToMigrate.push({ key, sourceNode });
            }
          }
        }
      }

      if (keysToMigrate.length === 0) {
        rebalanceLogger.info({ newNodeUrl }, 'no_keys_to_migrate');
        return { success: true, keysMoved: 0 };
      }

      logRebalanceStart('node_added', keysToMigrate.length);

      // Migrate keys in batches
      let keysMoved = 0;
      let keysFailed = 0;

      for (let i = 0; i < keysToMigrate.length; i += this.batchSize) {
        // Check timeout
        if (Date.now() - startTime > this.timeoutMs) {
          rebalanceLogger.error(
            { newNodeUrl, keysMoved, remaining: keysToMigrate.length - i },
            'rebalance_timeout'
          );
          break;
        }

        const batch = keysToMigrate.slice(i, i + this.batchSize);

        for (const { key, sourceNode } of batch) {
          try {
            // Get the key from source
            const getResult = await this.nodeRequest(
              sourceNode,
              `/cache/${encodeURIComponent(key)}`
            );

            if (getResult.success && getResult.data) {
              // Set the key on the new node
              const setResult = await this.nodeRequest(
                newNodeUrl,
                `/cache/${encodeURIComponent(key)}`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    value: getResult.data.value,
                    ttl: getResult.data.ttl > 0 ? getResult.data.ttl : 0,
                  }),
                }
              );

              if (setResult.success) {
                // Delete from source
                await this.nodeRequest(
                  sourceNode,
                  `/cache/${encodeURIComponent(key)}`,
                  { method: 'DELETE' }
                );

                keysMoved++;
                rebalanceKeysMoved.labels(sourceNode, newNodeUrl).inc();
              } else {
                keysFailed++;
              }
            }
          } catch (error) {
            keysFailed++;
            rebalanceLogger.debug(
              { key, error: error.message },
              'key_migration_failed'
            );
          }
        }

        // Log progress
        if ((i + this.batchSize) % (this.batchSize * 10) === 0) {
          logRebalanceProgress(keysMoved, keysToMigrate.length);
        }

        // Rate limiting delay
        await this._delay(this.delayMs);
      }

      const durationMs = Date.now() - startTime;
      rebalanceDuration.observe(durationMs / 1000);

      logRebalanceComplete(keysMoved, durationMs);

      return {
        success: true,
        keysMoved,
        keysFailed,
        durationMs,
      };
    } catch (error) {
      rebalanceLogger.error(
        { newNodeUrl, error: error.message },
        'rebalance_failed'
      );
      return { success: false, error: error.message };
    } finally {
      this.isRebalancing = false;
      rebalanceInProgress.labels(newNodeUrl).set(0);
    }
  }

  /**
   * Handle node removal - migrate keys from the removed node
   * Note: Keys on the removed node are lost unless replicated
   * This method handles graceful removal where we can still reach the node
   *
   * @param {string} removedNodeUrl - URL of the node being removed
   * @returns {Promise<object>} Rebalance result
   */
  async handleNodeRemoved(removedNodeUrl) {
    if (this.isRebalancing) {
      rebalanceLogger.warn(
        { removedNodeUrl },
        'rebalance_already_in_progress'
      );
      return { success: false, reason: 'Rebalance already in progress' };
    }

    const startTime = Date.now();
    this.isRebalancing = true;
    rebalanceInProgress.labels(removedNodeUrl).set(1);

    try {
      // Try to get keys from the node being removed
      const keysResult = await this.nodeRequest(removedNodeUrl, '/keys');

      if (!keysResult.success || !keysResult.data?.keys) {
        rebalanceLogger.warn(
          { removedNodeUrl },
          'cannot_get_keys_from_removed_node'
        );
        return {
          success: true,
          keysMoved: 0,
          reason: 'Could not retrieve keys from removed node',
        };
      }

      const keys = keysResult.data.keys;

      if (keys.length === 0) {
        return { success: true, keysMoved: 0 };
      }

      logRebalanceStart('node_removed', keys.length);

      // Migrate each key to its new home
      let keysMoved = 0;
      let keysFailed = 0;

      for (let i = 0; i < keys.length; i += this.batchSize) {
        // Check timeout
        if (Date.now() - startTime > this.timeoutMs) {
          rebalanceLogger.error(
            { removedNodeUrl, keysMoved, remaining: keys.length - i },
            'rebalance_timeout'
          );
          break;
        }

        const batch = keys.slice(i, i + this.batchSize);

        for (const key of batch) {
          try {
            // Get the new target node for this key
            const targetNode = this.ring.getNode(key);

            if (!targetNode || targetNode === removedNodeUrl) {
              keysFailed++;
              continue;
            }

            // Get the key from the removed node
            const getResult = await this.nodeRequest(
              removedNodeUrl,
              `/cache/${encodeURIComponent(key)}`
            );

            if (getResult.success && getResult.data) {
              // Set the key on the new node
              const setResult = await this.nodeRequest(
                targetNode,
                `/cache/${encodeURIComponent(key)}`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    value: getResult.data.value,
                    ttl: getResult.data.ttl > 0 ? getResult.data.ttl : 0,
                  }),
                }
              );

              if (setResult.success) {
                keysMoved++;
                rebalanceKeysMoved.labels(removedNodeUrl, targetNode).inc();
              } else {
                keysFailed++;
              }
            }
          } catch (error) {
            keysFailed++;
            rebalanceLogger.debug(
              { key, error: error.message },
              'key_migration_failed'
            );
          }
        }

        // Log progress
        if ((i + this.batchSize) % (this.batchSize * 10) === 0) {
          logRebalanceProgress(keysMoved, keys.length);
        }

        // Rate limiting delay
        await this._delay(this.delayMs);
      }

      const durationMs = Date.now() - startTime;
      rebalanceDuration.observe(durationMs / 1000);

      logRebalanceComplete(keysMoved, durationMs);

      return {
        success: true,
        keysMoved,
        keysFailed,
        durationMs,
      };
    } catch (error) {
      rebalanceLogger.error(
        { removedNodeUrl, error: error.message },
        'rebalance_failed'
      );
      return { success: false, error: error.message };
    } finally {
      this.isRebalancing = false;
      rebalanceInProgress.labels(removedNodeUrl).set(0);
    }
  }

  /**
   * Get current rebalance status
   * @returns {object}
   */
  getStatus() {
    return {
      isRebalancing: this.isRebalancing,
      currentRebalance: this.currentRebalance,
    };
  }

  /**
   * Calculate expected key migration for a hypothetical node addition
   * Useful for planning and impact analysis
   *
   * @param {string} newNodeUrl - Hypothetical new node
   * @returns {Promise<object>} Impact analysis
   */
  async analyzeAddNodeImpact(newNodeUrl) {
    const existingNodes = this.ring.getAllNodes();

    if (existingNodes.length === 0) {
      return {
        impact: 'none',
        keysToMigrate: 0,
        affectedNodes: [],
      };
    }

    // Collect keys from all existing nodes
    let totalKeys = 0;
    let keysToMigrate = 0;
    const affectedNodes = new Map();

    for (const sourceNode of existingNodes) {
      const keysResult = await this.nodeRequest(sourceNode, '/keys');
      if (keysResult.success && keysResult.data?.keys) {
        totalKeys += keysResult.data.keys.length;

        for (const key of keysResult.data.keys) {
          // Temporarily add the new node to check key assignment
          this.ring.addNode(newNodeUrl);
          const targetNode = this.ring.getNode(key);
          this.ring.removeNode(newNodeUrl);

          if (targetNode === newNodeUrl) {
            keysToMigrate++;
            affectedNodes.set(
              sourceNode,
              (affectedNodes.get(sourceNode) || 0) + 1
            );
          }
        }
      }
    }

    return {
      totalKeys,
      keysToMigrate,
      migrationPercentage: totalKeys > 0
        ? ((keysToMigrate / totalKeys) * 100).toFixed(2) + '%'
        : '0%',
      affectedNodes: Object.fromEntries(affectedNodes),
      estimatedDurationMs: Math.ceil(
        (keysToMigrate / this.batchSize) * this.delayMs
      ),
    };
  }

  /**
   * Helper to create a delay
   * @param {number} ms
   * @returns {Promise}
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Create a rebalance manager
 * @param {object} ring - ConsistentHashRing instance
 * @param {Function} nodeRequestFn - Function to make requests to nodes
 * @param {object} options
 * @returns {RebalanceManager}
 */
export function createRebalanceManager(ring, nodeRequestFn, options = {}) {
  return new RebalanceManager(ring, nodeRequestFn, options);
}

export default {
  RebalanceManager,
  createRebalanceManager,
};
