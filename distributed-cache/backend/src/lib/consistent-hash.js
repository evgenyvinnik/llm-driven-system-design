/**
 * Consistent Hash Ring implementation with virtual nodes
 *
 * This implements consistent hashing as described in the system design:
 * - Nodes and keys are hashed onto a ring (0 to 2^32-1)
 * - Key is assigned to the first node clockwise from its position
 * - Virtual nodes ensure even distribution
 */

import crypto from 'crypto';

export class ConsistentHashRing {
  constructor(virtualNodes = 150) {
    this.ring = new Map(); // hash -> node
    this.sortedHashes = [];
    this.virtualNodes = virtualNodes;
    this.nodes = new Set();
  }

  /**
   * Hash a string to a 32-bit integer
   * @param {string} key
   * @returns {number}
   */
  _hash(key) {
    const hash = crypto.createHash('md5').update(key).digest('hex');
    return parseInt(hash.substring(0, 8), 16);
  }

  /**
   * Add a node to the ring with virtual nodes
   * @param {string} nodeId - Unique identifier for the node (e.g., 'node-1' or 'localhost:3001')
   */
  addNode(nodeId) {
    if (this.nodes.has(nodeId)) {
      return; // Node already exists
    }

    this.nodes.add(nodeId);

    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${nodeId}:vn${i}`;
      const hashVal = this._hash(virtualKey);
      this.ring.set(hashVal, nodeId);
      this.sortedHashes.push(hashVal);
    }

    // Keep sorted for binary search
    this.sortedHashes.sort((a, b) => a - b);
  }

  /**
   * Remove a node from the ring
   * @param {string} nodeId
   */
  removeNode(nodeId) {
    if (!this.nodes.has(nodeId)) {
      return;
    }

    this.nodes.delete(nodeId);

    for (let i = 0; i < this.virtualNodes; i++) {
      const virtualKey = `${nodeId}:vn${i}`;
      const hashVal = this._hash(virtualKey);
      this.ring.delete(hashVal);
      const index = this.sortedHashes.indexOf(hashVal);
      if (index > -1) {
        this.sortedHashes.splice(index, 1);
      }
    }
  }

  /**
   * Get the node responsible for a key
   * @param {string} key
   * @returns {string|null} nodeId
   */
  getNode(key) {
    if (this.ring.size === 0) {
      return null;
    }

    const hashVal = this._hash(key);

    // Binary search for the first hash >= key hash
    let left = 0;
    let right = this.sortedHashes.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.sortedHashes[mid] < hashVal) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // Wrap around to the beginning if past the end
    if (left === this.sortedHashes.length) {
      left = 0;
    }

    return this.ring.get(this.sortedHashes[left]);
  }

  /**
   * Get multiple nodes for replication (returns n distinct nodes)
   * @param {string} key
   * @param {number} n - Number of nodes to return
   * @returns {string[]} Array of node IDs
   */
  getNodes(key, n = 3) {
    if (this.ring.size === 0) {
      return [];
    }

    const nodes = [];
    const seen = new Set();
    const hashVal = this._hash(key);

    // Binary search for starting position
    let left = 0;
    let right = this.sortedHashes.length;

    while (left < right) {
      const mid = Math.floor((left + right) / 2);
      if (this.sortedHashes[mid] < hashVal) {
        left = mid + 1;
      } else {
        right = mid;
      }
    }

    // Collect n unique nodes
    let idx = left;
    while (nodes.length < n && seen.size < this.nodes.size) {
      if (idx >= this.sortedHashes.length) {
        idx = 0;
      }

      const nodeId = this.ring.get(this.sortedHashes[idx]);
      if (!seen.has(nodeId)) {
        seen.add(nodeId);
        nodes.push(nodeId);
      }

      idx++;
    }

    return nodes;
  }

  /**
   * Get all nodes in the ring
   * @returns {string[]}
   */
  getAllNodes() {
    return Array.from(this.nodes);
  }

  /**
   * Get the number of nodes in the ring
   * @returns {number}
   */
  getNodeCount() {
    return this.nodes.size;
  }

  /**
   * Get the distribution of keys across nodes (for debugging/monitoring)
   * @param {string[]} keys - Array of keys to check distribution
   * @returns {Map<string, number>} Node to key count mapping
   */
  getDistribution(keys) {
    const distribution = new Map();

    for (const nodeId of this.nodes) {
      distribution.set(nodeId, 0);
    }

    for (const key of keys) {
      const nodeId = this.getNode(key);
      if (nodeId) {
        distribution.set(nodeId, distribution.get(nodeId) + 1);
      }
    }

    return distribution;
  }
}

export default ConsistentHashRing;
