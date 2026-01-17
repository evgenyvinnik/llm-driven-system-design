// API service for the Rate Limiter

import type {
  RateLimitResult,
  RateLimitCheckRequest,
  Metrics,
  HealthStatus,
  AlgorithmsResponse,
} from '../types';

const API_BASE = '/api';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok && response.status !== 429) {
    throw new Error(`API error: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

export const api = {
  // Check rate limit (consumes a token)
  async checkRateLimit(request: RateLimitCheckRequest): Promise<RateLimitResult> {
    const response = await fetch(`${API_BASE}/ratelimit/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    return handleResponse<RateLimitResult>(response);
  },

  // Get current state (does not consume a token)
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

  // Reset rate limit for an identifier
  async resetRateLimit(identifier: string, algorithm?: string): Promise<void> {
    const url = `${API_BASE}/ratelimit/reset/${encodeURIComponent(identifier)}${algorithm ? `?algorithm=${algorithm}` : ''}`;
    const response = await fetch(url, { method: 'DELETE' });
    await handleResponse<{ message: string }>(response);
  },

  // Get metrics
  async getMetrics(): Promise<Metrics> {
    const response = await fetch(`${API_BASE}/metrics`);
    return handleResponse<Metrics>(response);
  },

  // Get health status
  async getHealth(): Promise<HealthStatus> {
    const response = await fetch(`${API_BASE}/metrics/health`);
    return handleResponse<HealthStatus>(response);
  },

  // Get algorithm info
  async getAlgorithms(): Promise<AlgorithmsResponse> {
    const response = await fetch(`${API_BASE}/algorithms`);
    return handleResponse<AlgorithmsResponse>(response);
  },

  // Demo endpoint (rate limited)
  async hitDemo(apiKey?: string): Promise<{ message: string; timestamp: number; serverPort: number }> {
    const headers: HeadersInit = {};
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }
    const response = await fetch(`${API_BASE}/demo`, { headers });
    return handleResponse<{ message: string; timestamp: number; serverPort: number }>(response);
  },
};
