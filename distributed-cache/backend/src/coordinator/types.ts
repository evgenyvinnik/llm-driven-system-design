/**
 * Shared types for the coordinator module
 *
 * This module defines TypeScript interfaces and types used throughout
 * the coordinator for managing cache nodes, handling requests, and
 * tracking cluster state.
 */

import type { ConsistentHashRing } from '../lib/consistent-hash.js';

/**
 * Result of an HTTP request to a cache node.
 *
 * @description Encapsulates the outcome of making an HTTP request to a cache node,
 * including success status, response data, HTTP status code, and any error information.
 *
 * @property {boolean} success - Whether the request completed successfully
 * @property {unknown} [data] - The parsed JSON response data if successful
 * @property {number} [status] - The HTTP status code from the response
 * @property {unknown} [error] - Error information if the request failed
 */
export interface NodeRequestResult {
  success: boolean;
  data?: unknown;
  status?: number;
  error?: unknown;
}

/**
 * Function type for making requests to cache nodes.
 *
 * @description A function that sends HTTP requests to individual cache nodes
 * and returns the result. Used for all node communication including health checks,
 * cache operations, and administrative commands.
 *
 * @param {string} nodeUrl - The base URL of the cache node (e.g., 'http://localhost:3001')
 * @param {string} path - The API path to request (e.g., '/cache/mykey')
 * @param {RequestInit} [options] - Optional fetch options (method, body, headers, etc.)
 * @returns {Promise<NodeRequestResult>} The result of the request
 */
export type NodeRequestFn = (
  nodeUrl: string,
  path: string,
  options?: RequestInit
) => Promise<NodeRequestResult>;

/**
 * Cache statistics from a single node.
 *
 * @description Contains performance metrics and resource usage data
 * collected from an individual cache node. Used for cluster-wide
 * statistics aggregation.
 *
 * @property {string} nodeUrl - The URL of the node these stats came from
 * @property {number} hits - Number of cache hits
 * @property {number} misses - Number of cache misses
 * @property {number} sets - Number of set operations performed
 * @property {number} deletes - Number of delete operations performed
 * @property {number} evictions - Number of entries evicted due to capacity limits
 * @property {number} size - Current number of entries in the cache
 * @property {string} memoryMB - Approximate memory usage in megabytes
 * @property {HotKey[]} [hotKeys] - List of frequently accessed keys detected by the node
 */
export interface NodeStats {
  nodeUrl: string;
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  size: number;
  memoryMB: string;
  hotKeys?: HotKey[];
}

/**
 * Hot key information.
 *
 * @description Represents a frequently accessed cache key that may require
 * special handling (e.g., replication, read-through caching) to prevent
 * becoming a performance bottleneck.
 *
 * @property {string} key - The cache key identifier
 * @property {number} count - Number of accesses within the detection window
 * @property {string} [node] - The node URL where this hot key was detected
 */
export interface HotKey {
  key: string;
  count: number;
  node?: string;
}

/**
 * Result of fetching hot keys from a node.
 *
 * @description Container for hot key data retrieved from a specific cache node.
 *
 * @property {string} nodeUrl - The URL of the node that reported these hot keys
 * @property {HotKey[]} hotKeys - Array of detected hot keys from the node
 */
export interface NodeHotKeysResult {
  nodeUrl: string;
  hotKeys: HotKey[];
}

/**
 * Result of fetching keys from a node.
 *
 * @description Container for cache key listings retrieved from a specific node.
 *
 * @property {string} nodeUrl - The URL of the node that returned these keys
 * @property {string[]} keys - Array of cache key names stored on the node
 */
export interface KeysResult {
  nodeUrl: string;
  keys: string[];
}

/**
 * Status of a cache node.
 *
 * @description Comprehensive health and status information for a cache node,
 * including connectivity state, uptime, and failure tracking. Used by the
 * health monitor to make decisions about node availability.
 *
 * @property {string} url - The base URL of the cache node
 * @property {boolean} healthy - Whether the node is currently responsive
 * @property {string} [nodeId] - The node's self-reported identifier
 * @property {number} [uptime] - The node's uptime in seconds
 * @property {unknown} [cache] - Cache statistics from the node's health check
 * @property {string} [error] - Error message if the node is unhealthy
 * @property {string} lastCheck - ISO timestamp of the last health check
 * @property {number} consecutiveFailures - Number of failed health checks in a row
 */
export interface NodeStatusInfo {
  url: string;
  healthy: boolean;
  nodeId?: string;
  uptime?: number;
  cache?: unknown;
  error?: string;
  lastCheck: string;
  consecutiveFailures: number;
}

/**
 * Configuration for the coordinator.
 *
 * @description Settings that control the coordinator's behavior,
 * including network configuration, cluster topology, and feature flags.
 *
 * @property {number | string} port - The port the coordinator listens on
 * @property {string[]} nodes - Array of cache node URLs to manage
 * @property {number} healthCheckInterval - Milliseconds between health checks
 * @property {number} virtualNodes - Number of virtual nodes per physical node in the hash ring
 * @property {boolean} gracefulRebalance - Whether to migrate keys when nodes are added/removed
 */
export interface CoordinatorConfig {
  port: number | string;
  nodes: string[];
  healthCheckInterval: number;
  virtualNodes: number;
  gracefulRebalance: boolean;
}

/**
 * Coordinator context shared across modules.
 *
 * @description Central container for coordinator dependencies and state,
 * passed to various route handlers and utility functions. Provides access
 * to configuration, the consistent hash ring, node status tracking, and
 * the node request function.
 *
 * @property {CoordinatorConfig} config - The coordinator's configuration settings
 * @property {ConsistentHashRing} ring - The consistent hash ring for key routing
 * @property {Map<string, NodeStatusInfo>} nodeStatus - Map of node URLs to their status
 * @property {NodeRequestFn} nodeRequest - Function for making requests to cache nodes
 */
export interface CoordinatorContext {
  config: CoordinatorConfig;
  ring: ConsistentHashRing;
  nodeStatus: Map<string, NodeStatusInfo>;
  nodeRequest: NodeRequestFn;
}
