/**
 * Base URL for all API requests.
 * Uses the Vite proxy to forward requests to the backend server.
 */
const API_BASE = '/api';

/** Standard API error response format */
interface ApiError {
  error: string;
}

/**
 * Handles API response parsing and error handling.
 * Throws an error with the server's error message for non-OK responses.
 *
 * @template T - Expected response type
 * @param response - Fetch response object
 * @returns Promise resolving to parsed JSON response
 * @throws Error with server error message or 'Request failed'
 */
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error: ApiError = await response.json().catch(() => ({ error: 'Network error' }));
    throw new Error(error.error || 'Request failed');
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json();
}

/** Per-request options. `keepalive` lets a request outlive the page (exit saves). */
interface RequestOptions {
  keepalive?: boolean;
}

/**
 * Performs a GET request to the API.
 *
 * @template T - Expected response type
 * @param path - API endpoint path (without /api prefix)
 * @returns Promise resolving to typed response
 */
async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
  });
  return handleResponse<T>(response);
}

/**
 * Performs a POST request to the API.
 *
 * @template T - Expected response type
 * @param path - API endpoint path (without /api prefix)
 * @param body - Request body (will be JSON-serialized)
 * @returns Promise resolving to typed response
 */
async function post<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    keepalive: options?.keepalive,
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(response);
}

/**
 * Performs a PUT request to the API.
 *
 * @template T - Expected response type
 * @param path - API endpoint path (without /api prefix)
 * @param body - Request body (will be JSON-serialized)
 * @returns Promise resolving to typed response
 */
async function put<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
  });
  return handleResponse<T>(response);
}

/**
 * Performs a DELETE request to the API.
 *
 * @template T - Expected response type
 * @param path - API endpoint path (without /api prefix)
 * @returns Promise resolving to typed response
 */
async function del<T>(path: string, options?: RequestOptions): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: 'DELETE',
    keepalive: options?.keepalive,
    credentials: 'include',
  });
  return handleResponse<T>(response);
}

/**
 * API client with typed HTTP methods.
 * All methods include credentials for session cookie authentication.
 */
export const api = { get, post, put, del };
