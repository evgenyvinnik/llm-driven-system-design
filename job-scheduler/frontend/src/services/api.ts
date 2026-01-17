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

const API_BASE = '/api/v1';

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

// Health check
export async function checkHealth(): Promise<{ db: boolean; redis: boolean }> {
  const response = await fetchApi<{ db: boolean; redis: boolean }>('/health');
  return response.data || { db: false, redis: false };
}

// Jobs
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

export async function getJob(id: string): Promise<Job | null> {
  const response = await fetchApi<Job>(`/jobs/${id}`);
  return response.data || null;
}

export async function createJob(input: CreateJobInput): Promise<Job | null> {
  const response = await fetchApi<Job>('/jobs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
  return response.data || null;
}

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

export async function deleteJob(id: string): Promise<boolean> {
  const response = await fetchApi<void>(`/jobs/${id}`, {
    method: 'DELETE',
  });
  return response.success;
}

export async function pauseJob(id: string): Promise<Job | null> {
  const response = await fetchApi<Job>(`/jobs/${id}/pause`, {
    method: 'POST',
  });
  return response.data || null;
}

export async function resumeJob(id: string): Promise<Job | null> {
  const response = await fetchApi<Job>(`/jobs/${id}/resume`, {
    method: 'POST',
  });
  return response.data || null;
}

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

// Executions
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

export async function getExecution(id: string): Promise<JobExecution | null> {
  const response = await fetchApi<JobExecution>(`/executions/${id}`);
  return response.data || null;
}

export async function cancelExecution(id: string): Promise<JobExecution | null> {
  const response = await fetchApi<JobExecution>(`/executions/${id}/cancel`, {
    method: 'POST',
  });
  return response.data || null;
}

export async function retryExecution(id: string): Promise<JobExecution | null> {
  const response = await fetchApi<JobExecution>(`/executions/${id}/retry`, {
    method: 'POST',
  });
  return response.data || null;
}

// Metrics
export async function getMetrics(): Promise<SystemMetrics | null> {
  const response = await fetchApi<SystemMetrics>('/metrics');
  return response.data || null;
}

export async function getExecutionStats(
  hours: number = 24
): Promise<ExecutionStats[]> {
  const response = await fetchApi<ExecutionStats[]>(
    `/metrics/executions?hours=${hours}`
  );
  return response.data || [];
}

// Workers
export async function getWorkers(): Promise<Worker[]> {
  const response = await fetchApi<Worker[]>('/workers');
  return response.data || [];
}

// Dead letter queue
export async function getDeadLetterItems(
  start: number = 0,
  count: number = 100
): Promise<unknown[]> {
  const response = await fetchApi<unknown[]>(
    `/dead-letter?start=${start}&count=${count}`
  );
  return response.data || [];
}
