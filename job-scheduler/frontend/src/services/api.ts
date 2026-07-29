/**
 * API service for communicating with the job scheduler backend.
 * Provides typed functions for all API endpoints with consistent error handling.
 * @module services/api
 */

import {
  ApiResponse,
  PaginatedResponse,
  Job,
  JobWithStats,
  JobExecution,
  CreateJobInput,
  UpdateJobInput,
  SystemMetrics,
  Worker,
  ExecutionStats,
  JobStatus,
  ExecutionStatus,
} from '../types';

/** Base URL for all API requests */
const API_BASE = '/api/v1';

/**
 * Generic fetch wrapper with JSON handling and error processing.
 * @template T - Expected response data type
 * @param url - API endpoint path (without base URL)
 * @param options - Fetch options (method, body, etc.)
 * @returns Typed API response
 */
async function fetchApi<T>(
  url: string,
  options?: RequestInit
): Promise<ApiResponse<T>> {
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  const data = await response.json();
  return data as ApiResponse<T>;
}

// === Health Check ===

/**
 * Checks the health of the backend services.
 * @returns Object with database and Redis health status
 */
export async function checkHealth(): Promise<{ db: boolean; redis: boolean }> {
  const response = await fetchApi<{ db: boolean; redis: boolean }>('/health');
  return response.data || { db: false, redis: false };
}

// === Job Operations ===

/**
 * Fetches a paginated list of jobs.
 * @param page - Page number (1-indexed)
 * @param limit - Items per page
 * @param status - Optional status filter
 * @param withStats - Whether to include execution statistics
 * @returns Paginated job list
 */
export async function getJobs(
  page: number = 1,
  limit: number = 20,
  status?: JobStatus,
  withStats: boolean = false
): Promise<PaginatedResponse<Job | JobWithStats>> {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString(),
    withStats: withStats.toString(),
  });
  if (status) params.append('status', status);

  const response = await fetchApi<PaginatedResponse<Job | JobWithStats>>(
    `/jobs?${params}`
  );
  return (
    response.data || { items: [], total: 0, page: 1, limit: 20, total_pages: 0 }
  );
}

/**
 * Fetches a single job by ID.
 * @param id - Job UUID
 * @returns Job details or null if not found
 */
export async function getJob(id: string): Promise<Job | null> {
  const response = await fetchApi<Job>(`/jobs/${id}`);
  return response.data || null;
}

/**
 * Creates a new job.
 * @param input - Job creation parameters
 * @returns Created job or null on failure
 */
export async function createJob(input: CreateJobInput): Promise<Job | null> {
  const response = await fetchApi<Job>('/jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.data || null;
}

/**
 * Updates an existing job.
 * @param id - Job UUID to update
 * @param input - Fields to update
 * @returns Updated job or null if not found
 */
export async function updateJob(
  id: string,
  input: UpdateJobInput
): Promise<Job | null> {
  const response = await fetchApi<Job>(`/jobs/${id}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
  return response.data || null;
}

/**
 * Deletes a job and all its executions.
 * @param id - Job UUID to delete
 * @returns True if deleted successfully
 */
export async function deleteJob(id: string): Promise<boolean> {
  const response = await fetchApi<void>(`/jobs/${id}`, {
    method: 'DELETE',
  });
  return response.success;
}

/**
 * Pauses a job, preventing future executions.
 * @param id - Job UUID to pause
 * @returns Updated job or null
 */
export async function pauseJob(id: string): Promise<Job | null> {
  const response = await fetchApi<Job>(`/jobs/${id}/pause`, {
    method: 'POST',
  });
  return response.data || null;
}

/**
 * Resumes a paused job.
 * @param id - Job UUID to resume
 * @returns Updated job or null
 */
export async function resumeJob(id: string): Promise<Job | null> {
  const response = await fetchApi<Job>(`/jobs/${id}/resume`, {
    method: 'POST',
  });
  return response.data || null;
}

/**
 * Triggers immediate execution of a job.
 * @param id - Job UUID to trigger
 * @returns Job and new execution or null
 */
export async function triggerJob(
  id: string
): Promise<{ job: Job; execution: JobExecution } | null> {
  const response = await fetchApi<{ job: Job; execution: JobExecution }>(
    `/jobs/${id}/trigger`,
    {
      method: 'POST',
    }
  );
  return response.data || null;
}

// === Execution Operations ===

/**
 * Fetches a paginated list of executions.
 * @param jobId - Optional job UUID to filter by
 * @param page - Page number (1-indexed)
 * @param limit - Items per page
 * @param status - Optional status filter
 * @returns Paginated execution list
 */
export async function getExecutions(
  jobId?: string,
  page: number = 1,
  limit: number = 20,
  status?: ExecutionStatus
): Promise<PaginatedResponse<JobExecution>> {
  const params = new URLSearchParams({
    page: page.toString(),
    limit: limit.toString(),
  });
  if (status) params.append('status', status);

  const url = jobId ? `/jobs/${jobId}/executions?${params}` : `/executions?${params}`;
  const response = await fetchApi<PaginatedResponse<JobExecution>>(url);
  return (
    response.data || { items: [], total: 0, page: 1, limit: 20, total_pages: 0 }
  );
}

/**
 * Fetches a single execution by ID with logs.
 * @param id - Execution UUID
 * @returns Execution details or null if not found
 */
export async function getExecution(id: string): Promise<JobExecution | null> {
  const response = await fetchApi<JobExecution>(`/executions/${id}`);
  return response.data || null;
}

/**
 * Cancels a pending or running execution.
 * @param id - Execution UUID to cancel
 * @returns Updated execution or null
 */
export async function cancelExecution(id: string): Promise<JobExecution | null> {
  const response = await fetchApi<JobExecution>(`/executions/${id}/cancel`, {
    method: 'POST',
  });
  return response.data || null;
}

/**
 * Retries a failed or cancelled execution.
 * @param id - Execution UUID to retry
 * @returns New execution created for the retry
 */
export async function retryExecution(id: string): Promise<JobExecution | null> {
  const response = await fetchApi<JobExecution>(`/executions/${id}/retry`, {
    method: 'POST',
  });
  return response.data || null;
}

// === Metrics & Monitoring ===

/**
 * Fetches aggregated system metrics.
 * @returns System metrics for dashboard display
 */
export async function getMetrics(): Promise<SystemMetrics | null> {
  // `/api/v1/metrics/system`, not `/api/v1/metrics` — the latter does not exist
  // (the bare `/metrics` route is the Prometheus scrape endpoint at the server
  // root). Requesting the wrong path 404s, which this layer turns into a null
  // metrics object, so the dashboard rendered zeros for every card while the
  // job table beneath it was full of data.
  const response = await fetchApi<SystemMetrics>('/metrics/system');
  return response.data || null;
}

/**
 * Fetches hourly execution statistics for charts.
 * @param hours - Number of hours of history to fetch
 * @returns Array of hourly statistics
 */
export async function getExecutionStats(
  hours: number = 24
): Promise<ExecutionStats[]> {
  const response = await fetchApi<ExecutionStats[]>(
    `/metrics/executions?hours=${hours}`
  );
  return response.data || [];
}

/**
 * Fetches list of registered workers.
 * @returns Array of worker information
 */
export async function getWorkers(): Promise<Worker[]> {
  const response = await fetchApi<Worker[]>('/workers');
  return response.data || [];
}

/**
 * Fetches items from the dead letter queue.
 * @param start - Starting index
 * @param count - Number of items to fetch
 * @returns Array of dead letter queue items
 */
export async function getDeadLetterItems(
  start: number = 0,
  count: number = 100
): Promise<unknown[]> {
  const response = await fetchApi<unknown[]>(
    `/dead-letter?start=${start}&count=${count}`
  );
  return response.data || [];
}

// === Authentication ===
//
// The auth routes are mounted at `/api`, not `/api/v1` like everything else,
// so they bypass fetchApi's base URL. Session state is a cookie set by the
// backend; requests are same-origin through the Vite proxy, so it rides along.

/** Authenticated user as returned by the session endpoints. */
export interface AuthUser {
  id: string;
  username: string;
  role: 'user' | 'admin';
}

/**
 * Authenticates with username and password, establishing a session cookie.
 * @throws Error with the server's message when credentials are rejected
 */
export async function login(
  username: string,
  password: string
): Promise<AuthUser> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data: ApiResponse<{ user: AuthUser }> = await response.json();

  if (!response.ok || !data.success || !data.data) {
    throw new Error(data.error || 'Login failed');
  }
  return data.data.user;
}

/** Destroys the current session. */
export async function logout(): Promise<void> {
  await fetch('/api/auth/logout', { method: 'POST' });
}

/**
 * Returns the currently authenticated user, or null when there is no session.
 * Used on boot to restore a session rather than forcing a fresh login.
 */
export async function getCurrentUser(): Promise<AuthUser | null> {
  try {
    const response = await fetch('/api/auth/me');
    if (!response.ok) return null;
    const data: ApiResponse<AuthUser> = await response.json();
    return data.success ? data.data ?? null : null;
  } catch {
    return null;
  }
}
