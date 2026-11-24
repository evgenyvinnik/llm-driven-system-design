/**
 * @fileoverview API client for the web crawler backend.
 *
 * This module provides a centralized API client for all communication
 * with the crawler backend. It handles:
 * - HTTP requests to all API endpoints
 * - Response parsing and error handling
 * - Type-safe return values
 *
 * The API follows RESTful conventions:
 * - GET for reading data
 * - POST for creating/triggering actions
 * - PUT for updating resources
 * - DELETE for removing data
 *
 * @module services/api
 */

import type {
  CrawlStats,
  FrontierUrl,
  CrawledPage,
  Domain,
  FrontierStats,
  AuthUser,
  HealthStatus,
  ManagedUser,
  AuditEntry,
  IpPolicy,
} from '../types';

/**
 * Error thrown for non-2xx responses. Carries the HTTP status so callers can
 * tell "you need to sign in" (401) from "you may not" (403) from a server fault.
 */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Called whenever the API answers 401, i.e. the session expired or was never
 * there. The auth store registers itself here (rather than api.ts importing the
 * store) to avoid a circular import.
 */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

/**
 * Base URL for API requests.
 * In development, the Vite proxy forwards requests to the backend.
 */
const API_BASE = '/api';

/**
 * Generic fetch wrapper with error handling.
 *
 * Automatically sets Content-Type header and parses JSON responses.
 * Throws an error for non-2xx responses with the error message from the API.
 *
 * @template T - Expected response type
 * @param endpoint - API endpoint path (e.g., '/stats')
 * @param options - Optional fetch options (method, body, headers)
 * @returns Promise resolving to the typed response
 * @throws Error with message from API or HTTP status code
 */
async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    // Send the session cookie (same origin via the Vite proxy / nginx)
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401) onUnauthorized?.();
    throw new ApiError(body.message || body.error || `HTTP ${response.status}`, response.status);
  }

  return response.json();
}

/**
 * API client object with methods for each endpoint.
 *
 * All methods are async and return typed responses.
 * Errors are thrown on non-2xx responses.
 *
 * @example
 * ```typescript
 * import { api } from './services/api';
 *
 * // Get dashboard stats
 * const stats = await api.getStats();
 *
 * // Add URLs to frontier
 * const result = await api.addUrls(['https://example.com'], 3);
 * ```
 */
export const api = {
  // ============================================
  // Statistics endpoints
  // ============================================

  /**
   * Fetches comprehensive crawler statistics for the dashboard.
   * Combines real-time counters from Redis with database aggregations.
   *
   * @returns Promise resolving to complete CrawlStats object
   */
  getStats: () => fetchApi<CrawlStats>('/stats'),

  /**
   * Fetches time-series data for chart visualization.
   * Aggregates crawl results by hour for the specified window.
   *
   * @param hours - Number of hours to look back (default: 24)
   * @returns Promise resolving to timestamps and metrics arrays
   */
  getTimeSeries: (hours = 24) =>
    fetchApi<{ timestamps: string[]; pagesCrawled: number[]; pagesFailed: number[] }>(
      `/stats/timeseries?hours=${hours}`
    ),

  /**
   * Resets all statistics counters to zero.
   * Only affects Redis counters, not historical data.
   *
   * @returns Promise resolving to success message
   */
  resetStats: () => fetchApi<{ message: string }>('/stats/reset', { method: 'POST' }),

  // ============================================
  // Frontier endpoints
  // ============================================

  /**
   * Fetches aggregated statistics about the URL frontier.
   *
   * @returns Promise resolving to frontier stats by status
   */
  getFrontierStats: () => fetchApi<FrontierStats>('/frontier/stats'),

  /**
   * Fetches URLs from the frontier with optional filtering.
   *
   * @param limit - Maximum URLs to return (default: 50)
   * @param status - Optional filter by status (pending, in_progress, completed, failed)
   * @returns Promise resolving to array of FrontierUrl objects
   */
  getFrontierUrls: (limit = 50, status?: string) => {
    let url = `/frontier/urls?limit=${limit}`;
    if (status) url += `&status=${status}`;
    return fetchApi<FrontierUrl[]>(url);
  },

  /**
   * Adds URLs to the frontier for crawling.
   * Duplicates and non-crawlable URLs are automatically filtered.
   *
   * @param urls - Array of URL strings to add
   * @param priority - Priority level (1=low, 2=medium, 3=high)
   * @returns Promise resolving to object with added and total counts
   */
  addUrls: (urls: string[], priority?: number) =>
    fetchApi<{ added: number; total: number }>('/frontier/add', {
      method: 'POST',
      body: JSON.stringify({ urls, priority }),
    }),

  /**
   * Adds high-priority seed URLs to start a new crawl.
   * Seed URLs are stored separately and added with depth 0.
   *
   * @param urls - Array of seed URL strings
   * @param priority - Priority level (default: 3)
   * @returns Promise resolving to object with added and total counts
   */
  addSeedUrls: (urls: string[], priority = 3) =>
    fetchApi<{ added: number; total: number }>('/frontier/seed', {
      method: 'POST',
      body: JSON.stringify({ urls, priority }),
    }),

  /**
   * Recovers stale in-progress URLs stuck after worker crashes.
   *
   * @param minutes - Age threshold in minutes (default: 10)
   * @returns Promise resolving to object with recovered count
   */
  recoverStaleUrls: (minutes = 10) =>
    fetchApi<{ recovered: number }>(`/frontier/recover?minutes=${minutes}`, {
      method: 'POST',
    }),

  /**
   * Clears the entire URL frontier.
   * This is a destructive operation that cannot be undone.
   *
   * @returns Promise resolving to success message
   */
  clearFrontier: () => fetchApi<{ message: string }>('/frontier/clear', { method: 'DELETE' }),

  // ============================================
  // Pages endpoints
  // ============================================

  /**
   * Fetches paginated list of crawled pages with optional filtering.
   *
   * @param limit - Maximum pages to return (default: 50)
   * @param offset - Number of pages to skip for pagination
   * @param domain - Optional filter by domain
   * @param search - Optional search term for URL/title
   * @returns Promise resolving to object with pages array and pagination info
   */
  getPages: (limit = 50, offset = 0, domain?: string, search?: string) => {
    let url = `/pages?limit=${limit}&offset=${offset}`;
    if (domain) url += `&domain=${encodeURIComponent(domain)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    return fetchApi<{ pages: CrawledPage[]; total: number; limit: number; offset: number }>(url);
  },

  /**
   * Fetches details of a specific crawled page by URL hash.
   *
   * @param urlHash - SHA-256 hash of the page URL
   * @returns Promise resolving to complete page record
   */
  getPage: (urlHash: string) => fetchApi<CrawledPage>(`/pages/${urlHash}`),

  /**
   * Fetches all crawled pages for a specific domain.
   *
   * @param domain - Domain hostname to filter by
   * @param limit - Maximum pages to return (default: 50)
   * @returns Promise resolving to array of page records
   */
  getDomainPages: (domain: string, limit = 50) =>
    fetchApi<CrawledPage[]>(`/pages/domain/${encodeURIComponent(domain)}?limit=${limit}`),

  // ============================================
  // Domains endpoints
  // ============================================

  /**
   * Fetches paginated list of crawled domains with sorting.
   *
   * @param limit - Maximum domains to return (default: 50)
   * @param offset - Number of domains to skip for pagination
   * @param sortBy - Column to sort by (default: 'page_count')
   * @param order - Sort order (default: 'desc')
   * @returns Promise resolving to object with domains array and pagination info
   */
  getDomains: (limit = 50, offset = 0, sortBy = 'page_count', order = 'desc') =>
    fetchApi<{ domains: Domain[]; total: number; limit: number; offset: number }>(
      `/domains?limit=${limit}&offset=${offset}&sortBy=${sortBy}&order=${order}`
    ),

  /**
   * Fetches detailed information about a specific domain.
   *
   * @param domain - Domain hostname to look up
   * @returns Promise resolving to complete domain record
   */
  getDomain: (domain: string) => fetchApi<Domain>(`/domains/${encodeURIComponent(domain)}`),

  /**
   * Fetches cached robots.txt content for a domain.
   *
   * @param domain - Domain hostname
   * @returns Promise resolving to object with robotsTxt content
   */
  getDomainRobots: (domain: string) =>
    fetchApi<{ domain: string; robotsTxt: string; fetchedAt: string }>(
      `/domains/${encodeURIComponent(domain)}/robots`
    ),

  /**
   * Forces a fresh fetch of robots.txt for a domain.
   * Clears all caches and fetches from the network.
   *
   * @param domain - Domain hostname
   * @returns Promise resolving to updated robots.txt info
   */
  refreshRobots: (domain: string) =>
    fetchApi<{ domain: string; robotsTxt: string; fetchedAt: string; crawlDelay: number }>(
      `/domains/${encodeURIComponent(domain)}/refresh-robots`,
      { method: 'POST' }
    ),

  /**
   * Updates crawl settings for a specific domain.
   *
   * @param domain - Domain hostname
   * @param settings - Settings to update (crawlDelay, isAllowed)
   * @returns Promise resolving to success message
   */
  updateDomainSettings: (
    domain: string,
    settings: { crawlDelay?: number | null; isAllowed?: boolean }
  ) =>
    fetchApi<Domain>(`/domains/${encodeURIComponent(domain)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  // ============================================
  // Health endpoint
  // ============================================

  /**
   * Checks system health status.
   * Verifies connectivity to database and Redis.
   *
   * @returns Promise resolving to health status object
   */
  getHealth: () => fetchApi<HealthStatus>('/health'),

  // ============================================
  // Auth endpoints (session cookie)
  // ============================================

  getCurrentUser: () =>
    fetchApi<{ authenticated: boolean; user: AuthUser | null }>('/auth/me'),

  login: (username: string, password: string) =>
    fetchApi<{ message: string; user: AuthUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () => fetchApi<{ message: string }>('/auth/logout', { method: 'POST' }),

  changePassword: (currentPassword: string, newPassword: string) =>
    fetchApi<{ message: string }>('/auth/password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  // ============================================
  // User management (admin)
  // ============================================

  listUsers: () => fetchApi<{ users: ManagedUser[] }>('/admin/users'),

  revokeUserSessions: (id: number) =>
    fetchApi<{ message: string }>(`/admin/users/${id}/revoke-sessions`, { method: 'POST' }),

  logoutOthers: () => fetchApi<{ message: string }>('/auth/logout-others', { method: 'POST' }),

  // ============================================
  // Audit log + IP policy (admin)
  // ============================================

  getAuditLog: (params: { before?: number; action?: string; actor?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.before) q.set('before', String(params.before));
    if (params.action) q.set('action', params.action);
    if (params.actor) q.set('actor', params.actor);
    q.set('limit', String(params.limit ?? 25));
    return fetchApi<{ entries: AuditEntry[]; nextBefore: number | null }>(`/admin/audit?${q}`);
  },

  getIpPolicy: () => fetchApi<IpPolicy>('/admin/ip-policy'),

  refreshIpPolicy: () => fetchApi<IpPolicy>('/admin/ip-policy/refresh', { method: 'POST' }),

  createUser: (username: string, password: string, role: 'admin' | 'user') =>
    fetchApi<ManagedUser>('/admin/users', {
      method: 'POST',
      body: JSON.stringify({ username, password, role }),
    }),

  updateUser: (
    id: number,
    changes: { role?: 'admin' | 'user'; disabled?: boolean; password?: string }
  ) =>
    fetchApi<ManagedUser>(`/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    }),

  deleteUser: async (id: number) => {
    // 204 No Content: no JSON body to parse
    const res = await fetch(`${API_BASE}/admin/users/${id}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 401) onUnauthorized?.();
      throw new ApiError(body.error || `HTTP ${res.status}`, res.status);
    }
  },
};
