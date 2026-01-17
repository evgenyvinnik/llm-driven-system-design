/**
 * @fileoverview API service for the Rate Limiter frontend.
 *
 * Provides a centralized interface for all backend API calls.
 * Handles response parsing and error handling consistently.
 */

import type {
  RateLimitResult,
  RateLimitCheckRequest,
  Metrics,
  HealthStatus,
  AlgorithmsResponse,
} from '../types';

/** Base URL for all API endpoints */
const API_BASE = '/api';

/**
 * Generic response handler for API calls.
 * Parses JSON response and handles HTTP errors.
 * Note: 429 (Too Many Requests) is not treated as an error since
 * rate limit exceeded is a valid response for testing purposes.
 *
 * @param response - Fetch Response object
 * @returns Parsed JSON response
 * @throws Error if response status indicates a failure (except 429)
 */
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok && response.status !== 429) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * API client object containing all backend API methods.
 * Used by the Zustand store to communicate with the rate limiter backend.
 */
export const api = {
  /**
   * Check rate limit for an identifier (consumes a token).
   * This is the primary method for testing rate limiting behavior.
   *
   * @param request - Rate limit check parameters
   * @returns Rate limit result with allowed status and remaining quota
   */
  async checkRateLimit(request: RateLimitCheckRequest): Promise<RateLimitResult> {
    const response = await fetch(`${API_BASE}/ratelimit/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    return handleResponse<RateLimitResult>(response);
  },

  /**
   * Get current rate limit state without consuming a token.
   * Useful for displaying remaining quota without affecting it.
   *
   * @param identifier - Unique ID to query state for
   * @param params - Optional algorithm parameters
   * @returns Current rate limit state
   */
  async getState(
    identifier: string,
    params: {
      algorithm?: string;
      limit?: number;
      windowSeconds?: number;
      burstCapacity?: number;
      refillRate?: number;
      leakRate?: number;
    } = {}
  ): Promise<RateLimitResult> {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined) {
        searchParams.set(key, String(value));
      }
    });
    const queryString = searchParams.toString();
    const url = `${API_BASE}/ratelimit/state/${encodeURIComponent(identifier)}${queryString ? `?${queryString}` : ''}`;

    const response = await fetch(url);
    return handleResponse<RateLimitResult>(response);
  },

  /**
   * Reset rate limit state for an identifier.
   * Clears all stored state, allowing immediate access.
   *
   * @param identifier - Unique ID to reset
   * @param algorithm - Optional: reset only a specific algorithm's state
   */
  async resetRateLimit(identifier: string, algorithm?: string): Promise<void> {
    const url = `${API_BASE}/ratelimit/reset/${encodeURIComponent(identifier)}${algorithm ? `?algorithm=${algorithm}` : ''}`;
    const response = await fetch(url, { method: 'DELETE' });
    await handleResponse<{ message: string }>(response);
  },

  /**
   * Get aggregated metrics for the last 5 minutes.
   * Used by the MetricsDashboard component.
   *
   * @returns Metrics including request counts, latencies, and active identifiers
   */
  async getMetrics(): Promise<Metrics> {
    const response = await fetch(`${API_BASE}/metrics`);
    return handleResponse<Metrics>(response);
  },

  /**
   * Get health status of the backend service.
   * Used by the HealthStatus component.
   *
   * @returns Health status including Redis connection state and uptime
   */
  async getHealth(): Promise<HealthStatus> {
    const response = await fetch(`${API_BASE}/metrics/health`);
    return handleResponse<HealthStatus>(response);
  },

  /**
   * Get information about available rate limiting algorithms.
   * Used by the AlgorithmSelector component.
   *
   * @returns List of algorithms with descriptions, pros/cons, and parameters
   */
  async getAlgorithms(): Promise<AlgorithmsResponse> {
    const response = await fetch(`${API_BASE}/algorithms`);
    return handleResponse<AlgorithmsResponse>(response);
  },

  /**
   * Hit the demo endpoint (protected by rate limiting).
   * Tests the rate limiting middleware directly.
   *
   * @param apiKey - Optional API key for identification
   * @returns Demo response with message and server info
   */
  async hitDemo(apiKey?: string): Promise<{ message: string; timestamp: number; serverPort: number }> {
    const headers: HeadersInit = {};
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }
    const response = await fetch(`${API_BASE}/demo`, { headers });
    return handleResponse<{ message: string; timestamp: number; serverPort: number }>(response);
  },
};
