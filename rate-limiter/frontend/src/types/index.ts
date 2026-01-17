/**
 * @fileoverview Type definitions for the Rate Limiter frontend.
 *
 * These types mirror the backend types and are used for API communication
 * and component props throughout the frontend application.
 */

/**
 * Available rate limiting algorithms.
 * Each algorithm has different trade-offs for accuracy, memory, and burst handling.
 */
export type Algorithm =
  | 'fixed_window'
  | 'sliding_window'
  | 'sliding_log'
  | 'token_bucket'
  | 'leaky_bucket';

/**
 * Result of a rate limit check operation.
 * Returned by the backend check and state endpoints.
 */
export interface RateLimitResult {
  /** Whether the request was allowed */
  allowed: boolean;
  /** Number of requests remaining in the current window */
  remaining: number;
  /** Maximum requests allowed */
  limit: number;
  /** Unix timestamp (ms) when the limit resets */
  resetTime: number;
  /** Seconds to wait before retrying (only present when denied) */
  retryAfter?: number;
  /** Algorithm used for this check */
  algorithm?: Algorithm;
  /** Time taken to perform the check in milliseconds */
  latencyMs?: number;
  /** Identifier that was checked */
  identifier?: string;
}

/**
 * Request payload for checking rate limits.
 * Sent to the backend check endpoint.
 */
export interface RateLimitCheckRequest {
  /** Unique identifier for the rate limit subject */
  identifier: string;
  /** Algorithm to use for the check */
  algorithm?: Algorithm;
  /** Maximum requests per window */
  limit?: number;
  /** Window duration in seconds */
  windowSeconds?: number;
  /** Burst capacity for bucket algorithms */
  burstCapacity?: number;
  /** Token refill rate (tokens/second) */
  refillRate?: number;
  /** Leak rate (requests/second) */
  leakRate?: number;
}

/**
 * Aggregated metrics from the backend.
 * Used by the MetricsDashboard component.
 */
export interface Metrics {
  /** Total requests processed in the time window */
  totalRequests: number;
  /** Requests that were allowed */
  allowedRequests: number;
  /** Requests that were rate limited */
  deniedRequests: number;
  /** Average latency of rate limit checks in milliseconds */
  averageLatencyMs: number;
  /** 99th percentile latency in milliseconds */
  p99LatencyMs: number;
  /** Number of unique identifiers being tracked */
  activeIdentifiers: number;
}

/**
 * Health status response from the backend.
 * Used by the HealthStatus component.
 */
export interface HealthStatus {
  /** Overall health status */
  status: 'healthy' | 'unhealthy';
  /** Redis connection details */
  redis: {
    /** Whether Redis is connected */
    connected: boolean;
    /** Redis ping latency in milliseconds */
    pingMs?: number;
    /** Error message if not connected */
    error?: string;
  };
  /** Server uptime in seconds */
  uptime: number;
  /** Current server timestamp */
  timestamp: number;
}

/**
 * Information about a rate limiting algorithm.
 * Used by the AlgorithmSelector component.
 */
export interface AlgorithmInfo {
  /** Algorithm identifier */
  name: Algorithm;
  /** Human-readable description */
  description: string;
  /** List of advantages */
  pros: string[];
  /** List of disadvantages */
  cons: string[];
  /** Required/optional parameters */
  parameters: string[];
}

/**
 * Response from the algorithms endpoint.
 * Contains list of algorithms and default configuration.
 */
export interface AlgorithmsResponse {
  /** Available algorithms with documentation */
  algorithms: AlgorithmInfo[];
  /** Default rate limiting parameters */
  defaults: {
    algorithm: Algorithm;
    limit: number;
    windowSeconds: number;
    burstCapacity: number;
    refillRate: number;
    leakRate: number;
  };
}

/**
 * Individual test result for display in the TestResults component.
 * Created from RateLimitResult with added context.
 */
export interface TestResult {
  /** When the test was performed */
  timestamp: number;
  /** Identifier that was tested */
  identifier: string;
  /** Algorithm used */
  algorithm: Algorithm;
  /** Whether the request was allowed */
  allowed: boolean;
  /** Remaining requests after this check */
  remaining: number;
  /** Maximum requests allowed */
  limit: number;
  /** Latency of the check in milliseconds */
  latencyMs: number;
}
