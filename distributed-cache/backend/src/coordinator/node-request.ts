/**
 * HTTP request utilities for communicating with cache nodes
 *
 * This module provides a factory function for creating HTTP request handlers
 * that communicate with individual cache nodes. It handles timeouts, JSON
 * parsing, and error normalization.
 */

import type { NodeRequestResult, NodeRequestFn } from './types.js';

/**
 * Creates a node request function with configurable timeout.
 *
 * @description Factory function that returns a reusable HTTP request function
 * for communicating with cache nodes. The returned function handles:
 * - Request timeouts via AbortController
 * - JSON content type headers
 * - Response parsing and error extraction
 * - Network error handling
 *
 * @param {number} [timeoutMs=5000] - Request timeout in milliseconds. Requests
 *   that take longer than this will be aborted and return a failure result.
 * @returns {NodeRequestFn} A function that can make HTTP requests to cache nodes
 *
 * @example
 * ```typescript
 * const nodeRequest = createNodeRequest(3000);
 * const result = await nodeRequest('http://localhost:3001', '/cache/mykey');
 * if (result.success) {
 *   console.log('Value:', result.data);
 * }
 * ```
 */
export function createNodeRequest(timeoutMs = 5000): NodeRequestFn {
  /**
   * Makes an HTTP request to a cache node.
   *
   * @description Sends an HTTP request to the specified cache node with
   * automatic timeout handling and JSON parsing.
   *
   * @param {string} nodeUrl - The base URL of the cache node (e.g., 'http://localhost:3001')
   * @param {string} path - The API path to request (e.g., '/cache/mykey', '/health')
   * @param {RequestInit} [options={}] - Optional fetch options including method, body, headers
   * @returns {Promise<NodeRequestResult>} The request result with success status and data or error
   *
   * @throws This function does not throw - all errors are captured in the result object
   */
  return async function nodeRequest(
    nodeUrl: string,
    path: string,
    options: RequestInit = {}
  ): Promise<NodeRequestResult> {
    const url = `${nodeUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

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
  };
}
