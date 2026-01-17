// Types for the Rate Limiter frontend

export type Algorithm =
  | 'fixed_window'
  | 'sliding_window'
  | 'sliding_log'
  | 'token_bucket'
  | 'leaky_bucket';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetTime: number;
  retryAfter?: number;
  algorithm?: Algorithm;
  latencyMs?: number;
  identifier?: string;
}

export interface RateLimitCheckRequest {
  identifier: string;
  algorithm?: Algorithm;
  limit?: number;
  windowSeconds?: number;
  burstCapacity?: number;
  refillRate?: number;
  leakRate?: number;
}

export interface Metrics {
  totalRequests: number;
  allowedRequests: number;
  deniedRequests: number;
  averageLatencyMs: number;
  p99LatencyMs: number;
  activeIdentifiers: number;
}

export interface HealthStatus {
  status: 'healthy' | 'unhealthy';
  redis: {
    connected: boolean;
    pingMs?: number;
    error?: string;
  };
  uptime: number;
  timestamp: number;
}

export interface AlgorithmInfo {
  name: Algorithm;
  description: string;
  pros: string[];
  cons: string[];
  parameters: string[];
}

export interface AlgorithmsResponse {
  algorithms: AlgorithmInfo[];
  defaults: {
    algorithm: Algorithm;
    limit: number;
    windowSeconds: number;
    burstCapacity: number;
    refillRate: number;
    leakRate: number;
  };
}

export interface TestResult {
  timestamp: number;
  identifier: string;
  algorithm: Algorithm;
  allowed: boolean;
  remaining: number;
  limit: number;
  latencyMs: number;
}
