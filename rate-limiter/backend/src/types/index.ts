// Rate limiting types

export type Algorithm = 'fixed_window' | 'sliding_window' | 'sliding_log' | 'token_bucket' | 'leaky_bucket';

export type IdentifierType = 'api_key' | 'user_id' | 'ip';

export type UserTier = 'free' | 'pro' | 'enterprise';

export interface RateLimitRule {
  id: number;
  name: string;
  endpointPattern: string | null;
  identifierType: IdentifierType;
  userTier: UserTier | null;
  algorithm: Algorithm;
  limitValue: number;
  windowSeconds: number;
  burstCapacity?: number; // For token/leaky bucket
  refillRate?: number;    // For token bucket (tokens per second)
  leakRate?: number;      // For leaky bucket (requests per second)
  priority: number;
  enabled: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetTime: number;
  retryAfter?: number;
}

export interface RateLimitCheckRequest {
  identifier: string;
  identifierType: IdentifierType;
  endpoint?: string;
  userTier?: UserTier;
  algorithm?: Algorithm;
  limit?: number;
  windowSeconds?: number;
  burstCapacity?: number;
  refillRate?: number;
  leakRate?: number;
}

export interface RateLimitMetrics {
  totalRequests: number;
  allowedRequests: number;
  deniedRequests: number;
  averageLatencyMs: number;
  p99LatencyMs: number;
  activeIdentifiers: number;
}

export interface IdentifierMetrics {
  identifier: string;
  currentCount: number;
  limit: number;
  algorithm: Algorithm;
  windowSeconds: number;
  remaining: number;
  resetTime: number;
  requestsInLastMinute: number;
  deniedInLastMinute: number;
}
