/**
 * Request routing to cache nodes
 *
 * This module handles routing cache operations (GET, POST, PUT, DELETE) to the
 * appropriate cache nodes using consistent hashing for key distribution. It provides
 * an Express router that proxies requests to individual cache nodes.
 */

import { Router } from 'express';
import type { ConsistentHashRing } from '../lib/consistent-hash.js';
import type { NodeRequestFn, KeysResult } from './types.js';

/**
 * Gets the node responsible for a given cache key.
 *
 * @description Uses the consistent hash ring to determine which cache node
 * should handle operations for the specified key. This ensures consistent
 * key-to-node mapping across the cluster.
 *
 * @param {ConsistentHashRing} ring - The consistent hash ring for node lookup
 * @param {string} key - The cache key to locate
 * @returns {string} The URL of the node responsible for this key
 *
 * @throws {Error} Throws 'No healthy nodes available' if the ring has no active nodes
 *
 * @example
 * ```typescript
 * try {
 *   const nodeUrl = getNodeForKey(ring, 'user:123');
 *   console.log(`Key belongs to: ${nodeUrl}`);
 * } catch (error) {
 *   console.error('Cluster is unavailable');
 * }
 * ```
 */
export function getNodeForKey(ring: ConsistentHashRing, key: string): string {
  const nodeUrl = ring.getNode(key);
  if (!nodeUrl) {
    throw new Error('No healthy nodes available');
  }
  return nodeUrl;
}

/**
 * Creates an Express router for cache operations.
 *
 * @description Factory function that creates an Express router handling all
 * single-key and multi-key cache operations. Routes requests to the appropriate
 * cache node based on consistent hashing and includes routing metadata in responses.
 *
 * Supported routes:
 * - GET /cache/:key - Retrieve a cached value
 * - POST /cache/:key - Store a value in the cache
 * - PUT /cache/:key - Update an existing cached value
 * - DELETE /cache/:key - Remove a key from the cache
 * - POST /cache/:key/incr - Increment a numeric value
 * - GET /keys - List all keys across all nodes (with optional pattern)
 * - POST /flush - Clear all caches (requires admin auth at app level)
 *
 * @param {ConsistentHashRing} ring - The consistent hash ring for routing decisions
 * @param {NodeRequestFn} nodeRequest - Function for making HTTP requests to cache nodes
 * @returns {Router} An Express router configured with cache operation routes
 *
 * @example
 * ```typescript
 * const cacheRouter = createCacheRouter(ring, nodeRequest);
 * app.use(cacheRouter);
 * ```
 */
export function createCacheRouter(
  ring: ConsistentHashRing,
  nodeRequest: NodeRequestFn
): Router {
  const router = Router();

  /**
   * GET /cache/:key - Get a value (routed via consistent hashing)
   *
   * @description Retrieves a cached value from the appropriate node.
   * Response includes routing metadata showing which node handled the request.
   *
   * @returns 200 with value and routing info, 404 if not found, 503 if no nodes available
   */
  router.get('/cache/:key', async (req, res) => {
    const { key } = req.params;

    try {
      const nodeUrl = getNodeForKey(ring, key);
      const result = await nodeRequest(nodeUrl, `/cache/${encodeURIComponent(key)}`);

      if (result.success) {
        res.json({
          ...(result.data as object),
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
   *
   * @description Stores a value in the cache on the appropriate node.
   * Request body should contain { value: any, ttl?: number }.
   *
   * @returns 201 with confirmation and routing info, 503 if no nodes available
   */
  router.post('/cache/:key', async (req, res) => {
    const { key } = req.params;

    try {
      const nodeUrl = getNodeForKey(ring, key);
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
          ...(result.data as object),
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
   *
   * @description Updates an existing cached value on the appropriate node.
   * Functionally similar to POST but returns 200 instead of 201.
   *
   * @returns 200 with confirmation and routing info, 503 if no nodes available
   */
  router.put('/cache/:key', async (req, res) => {
    const { key } = req.params;

    try {
      const nodeUrl = getNodeForKey(ring, key);
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
          ...(result.data as object),
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
   *
   * @description Removes a key from the cache on the appropriate node.
   *
   * @returns 200 with confirmation and routing info, 404 if not found, 503 if no nodes available
   */
  router.delete('/cache/:key', async (req, res) => {
    const { key } = req.params;

    try {
      const nodeUrl = getNodeForKey(ring, key);
      const result = await nodeRequest(
        nodeUrl,
        `/cache/${encodeURIComponent(key)}`,
        {
          method: 'DELETE',
        }
      );

      if (result.success) {
        res.json({
          ...(result.data as object),
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
   *
   * @description Atomically increments a numeric value on the appropriate node.
   * Request body may contain { delta?: number } (defaults to 1).
   *
   * @returns 200 with new value and routing info, 400 if not a number, 503 if no nodes available
   */
  router.post('/cache/:key/incr', async (req, res) => {
    const { key } = req.params;

    try {
      const nodeUrl = getNodeForKey(ring, key);
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
          ...(result.data as object),
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
   *
   * @description Aggregates key listings from all active nodes in the cluster.
   * Supports pattern matching via query parameter.
   *
   * @query {string} pattern - Optional glob pattern to filter keys (default: '*')
   * @returns 200 with keys array, per-node counts, and total count (limited to 1000 keys)
   */
  router.get('/keys', async (req, res) => {
    const pattern = (req.query.pattern as string) || '*';
    const activeNodes = ring.getAllNodes() as string[];

    const keysPromises = activeNodes.map(async (nodeUrl: string): Promise<KeysResult> => {
      const result = await nodeRequest(
        nodeUrl,
        `/keys?pattern=${encodeURIComponent(pattern)}`
      );
      const data = result.data as { keys?: string[] } | undefined;
      return result.success
        ? { nodeUrl, keys: data?.keys || [] }
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
   * POST /flush - Flush all nodes (requires admin auth - applied at app level)
   *
   * @description Sends flush commands to all active nodes to clear their caches.
   * This is a destructive operation that removes all cached data.
   *
   * @returns 200 with flush results from each node
   */
  router.post('/flush', async (_req, res) => {
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

  return router;
}
