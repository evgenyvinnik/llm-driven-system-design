/**
 * @fileoverview Type definitions for the rate limiting service.
 * These types are shared across all rate limiting algorithms and API endpoints.
 */

/**
 * Supported rate limiting algorithms.
 * Each algorithm has different trade-offs for accuracy, memory, and burst handling.
 */
export type Algorithm = 'fixed_window' | 'sliding_window' | 'sliding_log' | 'token_bucket' | 'leaky_bucket';

/**
 * Types of identifiers used to track rate limits.
 * Determines how requests are grouped for rate limiting purposes.
 */
export type IdentifierType = 'api_key' | 'user_id' | 'ip';

/**
 * User subscription tiers that can have different rate limits.
 * Higher tiers typically have more generous limits.
 */
export type UserTier = 'free' | 'pro' | 'enterprise';

/**
 * Configuration for a rate limiting rule stored in the database.
 * Rules can be matched by endpoint pattern and user tier.
 */
export interface RateLimitRule {
  /** Unique identifier for the rule */
  id: number;
  /** Human-readable name for the rule */
  name: string;
  /** URL pattern to match (null matches all endpoints) */
  endpointPattern: string | null;
  /** How to identify the requester */
  identifierType: IdentifierType;
  /** Tier this rule applies to (null matches all tiers) */
  userTier: UserTier | null;
  /** Algorithm to use for rate limiting */
  algorithm: Algorithm;
  /** Maximum requests allowed in the window */
  limitValue: number;
  /** Time window in seconds */
  windowSeconds: number;
  /** For token/leaky bucket: maximum burst capacity */
  burstCapacity?: number;
  /** For token bucket: tokens added per second */
  refillRate?: number;
  /** For leaky bucket: requests processed per second */
  leakRate?: number;
  /** Higher priority rules are checked first */
  priority: number;
  /** Whether this rule is active */
  enabled: boolean;
}

/**
 * Result of a rate limit check operation.
 * Contains information needed for rate limit headers and client retry logic.
 */
export interface RateLimitResult {
  /** Whether the request is allowed */
  allowed: boolean;
  /** Number of requests remaining in the current window */
  remaining: number;
  /** Maximum requests allowed in the window */
  limit: number;
  /** Unix timestamp (ms) when the limit resets */
  resetTime: number;
  /** Seconds to wait before retrying (only present when denied) */
  retryAfter?: number;
}

/**
 * Request payload for checking rate limits via the API.
 * Allows clients to specify custom algorithm parameters.
 */
export interface RateLimitCheckRequest {
  /** Unique identifier for the requester */
  identifier: string;
  /** Type of identifier being used */
  identifierType: IdentifierType;
  /** API endpoint being accessed */
  endpoint?: string;
  /** User's subscription tier */
  userTier?: UserTier;
  /** Override the default algorithm */
  algorithm?: Algorithm;
  /** Override the default limit */
  limit?: number;
  /** Override the default window duration */
  windowSeconds?: number;
  /** Override burst capacity for bucket algorithms */
  burstCapacity?: number;
  /** Override refill rate for token bucket */
  refillRate?: number;
  /** Override leak rate for leaky bucket */
  leakRate?: number;
}

/**
 * Aggregated metrics for the rate limiting service.
 * Used for monitoring and dashboards.
 */
export interface RateLimitMetrics {
  /** Total requests processed */
  totalRequests: number;
  /** Requests that were allowed */
  allowedRequests: number;
  /** Requests that were rate limited */
  deniedRequests: number;
  /** Mean latency of rate limit checks in milliseconds */
  averageLatencyMs: number;
  /** 99th percentile latency in milliseconds */
  p99LatencyMs: number;
  /** Number of unique identifiers being tracked */
  activeIdentifiers: number;
}

/**
 * Per-identifier metrics showing rate limit state.
 * Useful for debugging and admin interfaces.
 */
export interface IdentifierMetrics {
  /** The identifier being tracked */
  identifier: string;
  /** Current request count in the window */
  currentCount: number;
  /** Maximum allowed requests */
  limit: number;
  /** Algorithm being used */
  algorithm: Algorithm;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Remaining requests allowed */
  remaining: number;
  /** When the limit resets (Unix ms) */
  resetTime: number;
  /** Recent request count for monitoring */
  requestsInLastMinute: number;
  /** Recent denied count for monitoring */
  deniedInLastMinute: number;
}
