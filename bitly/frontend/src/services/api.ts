/**
 * API Service for Bitly Frontend
 *
 * Provides typed methods for all backend API interactions.
 * Handles response parsing, error handling, and credential management.
 */

/** Base URL for API endpoints */
const API_BASE = '/api/v1';

/** Standard API error response structure */
interface ApiError {
  error: string;
}

/**
 * Processes fetch responses and handles errors.
 * Parses JSON for success responses, throws Error for failures.
 * @param response - Fetch Response object
 * @returns Parsed JSON response data
 * @throws Error with message from API or generic error
 */
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error: ApiError = await response.json();
    throw new Error(error.error || 'An error occurred');
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

/**
 * API client with methods organized by resource type.
 * All methods include credentials for cookie-based authentication.
 */
export const api = {
  /**
   * Authentication endpoints for user login, registration, and session management.
   */
  auth: {
    async login(email: string, password: string) {
      const response = await fetch(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      return handleResponse<{ user: import('../types').User; token: string }>(response);
    },

    async register(email: string, password: string) {
      const response = await fetch(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return handleResponse<import('../types').User>(response);
    },

    async logout() {
      const response = await fetch(`${API_BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      return handleResponse<{ message: string }>(response);
    },

    async me() {
      const response = await fetch(`${API_BASE}/auth/me`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').User>(response);
    },
  },

  /**
   * URL management endpoints for creating, listing, and managing shortened URLs.
   */
  urls: {
    async create(data: import('../types').CreateUrlInput) {
      const response = await fetch(`${API_BASE}/urls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      return handleResponse<import('../types').Url>(response);
    },

    async list(limit = 50, offset = 0) {
      const response = await fetch(`${API_BASE}/urls?limit=${limit}&offset=${offset}`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').UrlsResponse>(response);
    },

    async get(shortCode: string) {
      const response = await fetch(`${API_BASE}/urls/${shortCode}`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').Url>(response);
    },

    async update(shortCode: string, data: { is_active?: boolean; expires_at?: string | null }) {
      const response = await fetch(`${API_BASE}/urls/${shortCode}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      return handleResponse<import('../types').Url>(response);
    },

    async delete(shortCode: string) {
      const response = await fetch(`${API_BASE}/urls/${shortCode}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      return handleResponse<void>(response);
    },
  },

  /**
   * Analytics endpoints for viewing URL click statistics.
   */
  analytics: {
    async get(shortCode: string) {
      const response = await fetch(`${API_BASE}/analytics/${shortCode}`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').UrlAnalytics>(response);
    },
  },

  /**
   * Admin endpoints for system management.
   * Requires admin role for access.
   */
  admin: {
    async getStats() {
      const response = await fetch(`${API_BASE}/admin/stats`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').SystemStats>(response);
    },

    async getAnalytics() {
      const response = await fetch(`${API_BASE}/admin/analytics`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').GlobalAnalytics>(response);
    },

    async getUrls(limit = 50, offset = 0, filters?: { is_active?: boolean; is_custom?: boolean; search?: string }) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (filters?.is_active !== undefined) params.set('is_active', String(filters.is_active));
      if (filters?.is_custom !== undefined) params.set('is_custom', String(filters.is_custom));
      if (filters?.search) params.set('search', filters.search);

      const response = await fetch(`${API_BASE}/admin/urls?${params}`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').UrlsResponse>(response);
    },

    async deactivateUrl(shortCode: string) {
      const response = await fetch(`${API_BASE}/admin/urls/${shortCode}/deactivate`, {
        method: 'POST',
        credentials: 'include',
      });
      return handleResponse<{ message: string }>(response);
    },

    async reactivateUrl(shortCode: string) {
      const response = await fetch(`${API_BASE}/admin/urls/${shortCode}/reactivate`, {
        method: 'POST',
        credentials: 'include',
      });
      return handleResponse<{ message: string }>(response);
    },

    async getUsers(limit = 50, offset = 0) {
      const response = await fetch(`${API_BASE}/admin/users?limit=${limit}&offset=${offset}`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').UsersResponse>(response);
    },

    async updateUserRole(userId: string, role: 'user' | 'admin') {
      const response = await fetch(`${API_BASE}/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role }),
      });
      return handleResponse<import('../types').User>(response);
    },

    async getKeyPoolStats() {
      const response = await fetch(`${API_BASE}/admin/key-pool`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').KeyPoolStats>(response);
    },

    async repopulateKeyPool(count = 1000) {
      const response = await fetch(`${API_BASE}/admin/key-pool/repopulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ count }),
      });
      return handleResponse<{ message: string }>(response);
    },
  },
};
