import type {
  ClusterInfo,
  ClusterStats,
  CacheEntry,
  KeysResponse,
  HealthResponse,
} from '../types';

const API_BASE = '/api';

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export const cacheApi = {
  // Health & Cluster
  getHealth: () => fetchJson<HealthResponse>('/health'),
  getClusterInfo: () => fetchJson<ClusterInfo>('/cluster/info'),
  getClusterStats: () => fetchJson<ClusterStats>('/cluster/stats'),
  forceHealthCheck: () =>
    fetchJson<{ message: string; results: unknown[] }>('/admin/health-check', {
      method: 'POST',
    }),

  // Cache Operations
  get: (key: string) => fetchJson<CacheEntry>(`/cache/${encodeURIComponent(key)}`),
  set: (key: string, value: unknown, ttl?: number) =>
    fetchJson<CacheEntry>(`/cache/${encodeURIComponent(key)}`, {
      method: 'POST',
      body: JSON.stringify({ value, ttl }),
    }),
  delete: (key: string) =>
    fetchJson<{ key: string; message: string }>(`/cache/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }),
  incr: (key: string, delta: number = 1) =>
    fetchJson<{ key: string; value: number }>(`/cache/${encodeURIComponent(key)}/incr`, {
      method: 'POST',
      body: JSON.stringify({ delta }),
    }),

  // Key Operations
  getKeys: (pattern: string = '*') =>
    fetchJson<KeysResponse>(`/keys?pattern=${encodeURIComponent(pattern)}`),
  flush: () => fetchJson<{ message: string; results: unknown[] }>('/flush', { method: 'POST' }),

  // Cluster Operations
  locateKey: (key: string) =>
    fetchJson<{ key: string; nodeUrl: string; allNodes: string[] }>(
      `/cluster/locate/${encodeURIComponent(key)}`
    ),
  addNode: (url: string) =>
    fetchJson<{ message: string; status: unknown }>('/admin/node', {
      method: 'POST',
      body: JSON.stringify({ url }),
    }),
  removeNode: (url: string) =>
    fetchJson<{ message: string; remainingNodes: string[] }>('/admin/node', {
      method: 'DELETE',
      body: JSON.stringify({ url }),
    }),
};
