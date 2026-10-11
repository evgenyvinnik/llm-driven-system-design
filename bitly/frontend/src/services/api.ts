/**
 * API Service for Bitly Frontend
 *
 * Provides typed methods for all backend API interactions.
 * Handles response parsing, error handling, and credential management.
 */

/** Base URL for API endpoints */
const API_BASE = '/api/v1';

/**
 * Error thrown for failed API calls.
 * status is the HTTP status, or 0 when no response arrived at all (offline, connection
 * reset) - in that case the request may or may not have been processed by the server.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }

  /** True when the request never got an HTTP response. */
  get isNetworkError(): boolean {
    return this.status === 0;
  }
}

/**
 * Whether an error came from an aborted request (AbortController), which callers ignore.
 * @param error - Any thrown value
 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

/**
 * fetch wrapper that turns transport failures into ApiError(status 0).
 * Aborts are rethrown unchanged so callers can tell them apart.
 */
async function request(input: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    throw new ApiError('Network error - check your connection and try again', 0);
  }
}

/**
 * Processes fetch responses and handles errors.
 * Parses JSON for success responses, throws ApiError for failures (including error
 * bodies that are not JSON, e.g. a proxy's HTML 502 page).
 * @param response - Fetch Response object
 * @returns Parsed JSON response data
 * @throws ApiError with the API's message or a generic one
 */
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) {
        message = body.error;
      }
    } catch {
      // Non-JSON error body: keep the generic message
    }
    throw new ApiError(message, response.status);
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
      const response = await request(`${API_BASE}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password }),
      });
      return handleResponse<{ user: import('../types').User; token: string }>(response);
    },

    async register(email: string, password: string) {
      const response = await request(`${API_BASE}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      return handleResponse<import('../types').User>(response);
    },

    async logout() {
      const response = await request(`${API_BASE}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
      });
      return handleResponse<{ message: string }>(response);
    },

    async me() {
      const response = await request(`${API_BASE}/auth/me`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').User>(response);
    },
  },

  /**
   * URL management endpoints for creating, listing, and managing shortened URLs.
   */
  urls: {
    /**
     * Creates a short link. Pass the same idempotencyKey when retrying the same draft:
     * the server then replays the original result instead of creating a second link.
     */
    async create(data: import('../types').CreateUrlInput, options: { idempotencyKey?: string } = {}) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (options.idempotencyKey) {
        headers['Idempotency-Key'] = options.idempotencyKey;
      }
      const response = await request(`${API_BASE}/urls`, {
        method: 'POST',
        headers,
        credentials: 'include',
        body: JSON.stringify(data),
      });
      return handleResponse<import('../types').Url>(response);
    },

    async list(limit = 50, offset = 0) {
      const response = await request(`${API_BASE}/urls?limit=${limit}&offset=${offset}`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').UrlsResponse>(response);
    },

    async get(shortCode: string) {
      const response = await request(`${API_BASE}/urls/${shortCode}`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').Url>(response);
    },

    async update(shortCode: string, data: { is_active?: boolean; expires_at?: string | null }) {
      const response = await request(`${API_BASE}/urls/${shortCode}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(data),
      });
      return handleResponse<import('../types').Url>(response);
    },

    async delete(shortCode: string) {
      const response = await request(`${API_BASE}/urls/${shortCode}`, {
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
    async get(shortCode: string, signal?: AbortSignal) {
      const response = await request(`${API_BASE}/analytics/${shortCode}`, {
        credentials: 'include',
        signal,
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
      const response = await request(`${API_BASE}/admin/stats`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').SystemStats>(response);
    },

    async getAnalytics() {
      const response = await request(`${API_BASE}/admin/analytics`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').GlobalAnalytics>(response);
    },

    async getUrls(limit = 50, offset = 0, filters?: { is_active?: boolean; is_custom?: boolean; search?: string }) {
      const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
      if (filters?.is_active !== undefined) params.set('is_active', String(filters.is_active));
      if (filters?.is_custom !== undefined) params.set('is_custom', String(filters.is_custom));
      if (filters?.search) params.set('search', filters.search);

      const response = await request(`${API_BASE}/admin/urls?${params}`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').UrlsResponse>(response);
    },

    async deactivateUrl(shortCode: string) {
      const response = await request(`${API_BASE}/admin/urls/${shortCode}/deactivate`, {
        method: 'POST',
        credentials: 'include',
      });
      return handleResponse<{ message: string }>(response);
    },

    async reactivateUrl(shortCode: string) {
      const response = await request(`${API_BASE}/admin/urls/${shortCode}/reactivate`, {
        method: 'POST',
        credentials: 'include',
      });
      return handleResponse<{ message: string }>(response);
    },

    async getUsers(limit = 50, offset = 0) {
      const response = await request(`${API_BASE}/admin/users?limit=${limit}&offset=${offset}`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').UsersResponse>(response);
    },

    async updateUserRole(userId: string, role: 'user' | 'admin') {
      const response = await request(`${API_BASE}/admin/users/${userId}/role`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ role }),
      });
      return handleResponse<import('../types').User>(response);
    },

    async getKeyPoolStats() {
      const response = await request(`${API_BASE}/admin/key-pool`, {
        credentials: 'include',
      });
      return handleResponse<import('../types').KeyPoolStats>(response);
    },

    async repopulateKeyPool(count = 1000) {
      const response = await request(`${API_BASE}/admin/key-pool/repopulate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ count }),
      });
      return handleResponse<{ message: string }>(response);
    },
  },
};
