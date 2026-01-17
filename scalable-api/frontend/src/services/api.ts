const API_BASE = '/api/v1';

export interface DashboardData {
  metrics: {
    timestamp: string;
    uptime: {
      seconds: number;
      human: string;
    };
    memory: {
      heapUsed: number;
      heapTotal: number;
      rss: number;
      external: number;
    };
    requests: Record<string, { total: number; byStatus: Record<string, number> }>;
    errors: Record<string, number>;
    durations: Record<string, { count: number; avg: number; p50: number; p90: number; p99: number }>;
    counters: Record<string, number>;
    gauges: Record<string, number>;
  };
  circuitBreakers: Record<string, {
    name: string;
    state: 'closed' | 'open' | 'half-open';
    failures: number;
    lastFailure: string | null;
    stats: {
      totalCalls: number;
      successfulCalls: number;
      failedCalls: number;
      rejectedCalls: number;
    };
  }>;
  cache: {
    localHits: number;
    redisHits: number;
    misses: number;
    localCacheSize: number;
    hitRate: number;
  };
}

class ApiClient {
  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    token?: string
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Request failed' }));
      throw new Error(error.error || `HTTP ${response.status}`);
    }

    return response.json();
  }

  async login(email: string, password: string) {
    return this.request<{ token: string; user: { id: string; email: string; role: string } }>(
      '/auth/login',
      {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }
    );
  }

  async logout(token: string) {
    return this.request<{ message: string }>('/auth/logout', { method: 'POST' }, token);
  }

  async getMe(token: string) {
    return this.request<{ user: { id: string; email: string; role: string } }>('/me', {}, token);
  }

  async getStatus(token: string) {
    return this.request<{ status: string; version: string }>('/status', {}, token);
  }

  async getDashboard(token: string): Promise<DashboardData> {
    return this.request<DashboardData>('/admin/dashboard', {}, token);
  }

  async getCircuitBreakers(token: string) {
    return this.request<Record<string, unknown>>('/admin/circuit-breakers', {}, token);
  }

  async resetCircuitBreaker(token: string, name: string) {
    return this.request<{ message: string }>(
      `/admin/circuit-breakers/${name}/reset`,
      { method: 'POST' },
      token
    );
  }

  async getMetrics(token: string) {
    return this.request<unknown>('/admin/metrics', {}, token);
  }

  async resetMetrics(token: string) {
    return this.request<{ message: string }>('/admin/metrics/reset', { method: 'POST' }, token);
  }

  async getCacheStats(token: string) {
    return this.request<unknown>('/admin/cache', {}, token);
  }

  async clearCache(token: string) {
    return this.request<{ message: string }>('/admin/cache/clear', { method: 'POST' }, token);
  }

  async getResources(token: string, page = 1, limit = 10) {
    return this.request<{ resources: unknown[]; pagination: unknown }>(
      `/resources?page=${page}&limit=${limit}`,
      {},
      token
    );
  }

  async callExternalService(token: string) {
    return this.request<{ data: string; timestamp: string }>('/external', {}, token);
  }
}

export const api = new ApiClient();
