/**
 * @fileoverview API client for communicating with the App Store backend.
 * Provides typed HTTP methods with automatic authentication handling.
 */

/** Base URL for all API requests */
const API_BASE = '/api/v1';

/**
 * Makes an authenticated HTTP request to the API.
 * Automatically includes session token from localStorage if present.
 * @template T - Expected response type
 * @param endpoint - API endpoint path (e.g., '/apps')
 * @param options - Fetch options (method, body, headers)
 * @returns Parsed JSON response
 * @throws Error if response is not OK (4xx or 5xx status)
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const url = `${API_BASE}${endpoint}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...options.headers as Record<string, string>,
  };

  // Get session from localStorage
  const sessionId = localStorage.getItem('sessionId');
  if (sessionId) {
    headers['Authorization'] = `Bearer ${sessionId}`;
  }

  const response = await fetch(url, {
    ...options,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

/**
 * API client with convenience methods for common HTTP operations.
 * All methods are automatically authenticated if a session exists.
 */
export const api = {
  /** Makes a GET request */
  get: <T>(endpoint: string) => request<T>(endpoint),
  /** Makes a POST request with JSON body */
  post: <T>(endpoint: string, data?: unknown) =>
    request<T>(endpoint, { method: 'POST', body: JSON.stringify(data) }),
  /** Makes a PUT request with JSON body */
  put: <T>(endpoint: string, data?: unknown) =>
    request<T>(endpoint, { method: 'PUT', body: JSON.stringify(data) }),
  /** Makes a DELETE request */
  delete: <T>(endpoint: string) => request<T>(endpoint, { method: 'DELETE' }),
};

export default api;
