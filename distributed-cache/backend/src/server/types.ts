/**
 * Shared Types for Cache Server
 *
 * This module defines TypeScript types and interfaces used across
 * the cache server modules. These types ensure consistent data structures
 * for configuration, request/response bodies, and shared dependencies.
 *
 * @module server/types
 */

import type { Request, Response, NextFunction } from 'express';
import type { LRUCache } from '../lib/lru-cache.js';
import type { HotKeyDetector } from '../shared/metrics.js';
import type { PersistenceManager } from '../shared/persistence.js';
import type { Logger } from 'pino';

/**
 * Cache server configuration loaded from environment variables.
 *
 * @description Contains all configuration settings for a cache server node,
 * including network settings, cache limits, and defaults.
 *
 * @property {number | string} port - The port the server listens on
 * @property {string} nodeId - Unique identifier for this cache node
 * @property {number} maxSize - Maximum number of entries the cache can hold
 * @property {number} maxMemoryMB - Maximum memory usage in megabytes
 * @property {number} defaultTTL - Default TTL in seconds for entries without explicit TTL (0 = no expiration)
 */
export interface ServerConfig {
  port: number | string;
  nodeId: string;
  maxSize: number;
  maxMemoryMB: number;
  defaultTTL: number;
}

/**
 * Cache entry for bulk operations.
 *
 * @description Represents a single cache entry used in bulk set operations (mset).
 * Contains the key, value, and optional TTL for the entry.
 *
 * @property {string} key - The cache key identifier
 * @property {unknown} value - The value to store
 * @property {number} [ttl] - Optional TTL in seconds (uses default if not specified)
 */
export interface CacheEntry {
  key: string;
  value: unknown;
  ttl?: number;
}

/**
 * Request body for cache set operations.
 *
 * @description The expected request body format for POST /cache/:key and PUT /cache/:key.
 *
 * @property {unknown} value - The value to store in the cache
 * @property {number} [ttl] - Optional TTL in seconds (uses default if not specified)
 */
export interface SetRequestBody {
  value: unknown;
  ttl?: number;
}

/**
 * Request body for bulk get operations.
 *
 * @description The expected request body format for POST /mget.
 *
 * @property {string[]} keys - Array of cache keys to retrieve
 */
export interface MGetRequestBody {
  keys: string[];
}

/**
 * Request body for bulk set operations.
 *
 * @description The expected request body format for POST /mset.
 *
 * @property {CacheEntry[]} entries - Array of cache entries to store
 */
export interface MSetRequestBody {
  entries: CacheEntry[];
}

/**
 * Request body for expire operation.
 *
 * @description The expected request body format for POST /cache/:key/expire.
 *
 * @property {number} ttl - The new TTL in seconds to set on the key
 */
export interface ExpireRequestBody {
  ttl: number;
}

/**
 * Request body for increment operation.
 *
 * @description The expected request body format for POST /cache/:key/incr.
 *
 * @property {number} [delta=1] - The amount to increment by (can be negative for decrement)
 */
export interface IncrRequestBody {
  delta?: number;
}

/**
 * Response for health check endpoint.
 *
 * @description The response format for GET /health, providing comprehensive
 * information about the server's health, cache state, and resource usage.
 *
 * @property {string} status - Health status ('healthy' or 'degraded')
 * @property {string} nodeId - The cache node's identifier
 * @property {number | string} port - The port the server is listening on
 * @property {number} uptime - Server uptime in seconds
 * @property {Object} cache - Cache statistics
 * @property {number} cache.entries - Number of entries in the cache
 * @property {string} cache.memoryMB - Approximate memory usage in MB
 * @property {string} cache.hitRate - Cache hit rate as a percentage string
 * @property {Object} process - Process memory statistics
 * @property {string} process.heapUsedMB - Used heap memory in MB
 * @property {string} process.heapTotalMB - Total heap memory in MB
 * @property {string} process.rssMB - Resident set size in MB
 * @property {string} timestamp - ISO timestamp of the response
 */
export interface HealthResponse {
  status: string;
  nodeId: string;
  port: number | string;
  uptime: number;
  cache: {
    entries: number;
    memoryMB: string;
    hitRate: string;
  };
  process: {
    heapUsedMB: string;
    heapTotalMB: string;
    rssMB: string;
  };
  timestamp: string;
}

/**
 * Server context containing shared dependencies.
 *
 * @description Central container for all shared dependencies that route handlers
 * need access to. Passed to route factory functions for dependency injection.
 *
 * @property {LRUCache} cache - The LRU cache instance for storing data
 * @property {HotKeyDetector} hotKeyDetector - Detector for identifying frequently accessed keys
 * @property {PersistenceManager} persistence - Manager for snapshot persistence
 * @property {Logger} logger - Pino logger instance for structured logging
 * @property {ServerConfig} config - Server configuration settings
 */
export interface ServerContext {
  cache: LRUCache;
  hotKeyDetector: HotKeyDetector;
  persistence: PersistenceManager;
  logger: Logger;
  config: ServerConfig;
}

/**
 * Extended Express Request with cache key params.
 *
 * @description Type-safe extension of Express Request that ensures the
 * key parameter is present in route params.
 *
 * @property {Object} params - URL parameters
 * @property {string} params.key - The cache key from the URL
 */
export interface CacheKeyRequest extends Request {
  params: {
    key: string;
  };
}

/**
 * Async request handler type for Express.
 *
 * @description Function signature for async Express route handlers that
 * can be wrapped with error handling middleware.
 *
 * @param {Request} req - Express request object
 * @param {Response} res - Express response object
 * @param {NextFunction} next - Express next function for error handling
 * @returns {Promise<void>} Promise that resolves when the handler completes
 */
export type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction
) => Promise<void>;

/**
 * Error response format.
 *
 * @description Standard format for error responses from the cache server.
 *
 * @property {string} error - The error type or message
 * @property {string} [key] - The cache key involved in the error (if applicable)
 * @property {string} [message] - Additional error details
 */
export interface ErrorResponse {
  error: string;
  key?: string;
  message?: string;
}

/**
 * Cache operation types for metrics.
 *
 * @description The types of cache operations that are tracked for metrics.
 * Used to label Prometheus metrics and measure operation latencies.
 */
export type CacheOperation = 'get' | 'set' | 'delete';
