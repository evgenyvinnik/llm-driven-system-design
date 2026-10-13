/**
 * Zustand stores for global application state management.
 * Provides reactive state for jobs, executions, and system metrics.
 * @module stores
 */

import { create } from 'zustand';
import { Job, JobWithStats, JobExecution, SystemMetrics, Worker } from '../types';
import * as api from '../services/api';

/**
 * Runs a non-idempotent request under one Idempotency-Key and retries it once with the
 * same key if the network failed (fetch throws a TypeError before any response). The
 * server answers the retry with the original result, so a lost response can never turn
 * one click into two runs.
 */
async function withIdempotentRetry<T>(send: (key: string) => Promise<T>): Promise<T> {
  const key = crypto.randomUUID();
  try {
    return await send(key);
  } catch (error) {
    if (error instanceof TypeError) {
      return send(key);
    }
    throw error;
  }
}

/**
 * Jobs state interface.
 * Manages job list, selection, and CRUD operations.
 */
interface JobsState {
  jobs: (Job | JobWithStats)[];
  selectedJob: Job | null;
  loading: boolean;
  error: string | null;
  page: number;
  totalPages: number;
  /** Jobs with a trigger request in flight; a second click is ignored until it settles. */
  triggering: string[];
  fetchJobs: (page?: number) => Promise<void>;
  fetchJob: (id: string) => Promise<void>;
  /** Throws the server's reason (validation details, duplicate name) so the form can show it. */
  createJob: (input: Parameters<typeof api.createJob>[0], idempotencyKey?: string) => Promise<Job>;
  updateJob: (id: string, input: Parameters<typeof api.updateJob>[1]) => Promise<Job | null>;
  deleteJob: (id: string) => Promise<boolean>;
  pauseJob: (id: string) => Promise<void>;
  resumeJob: (id: string) => Promise<void>;
  triggerJob: (id: string) => Promise<JobExecution | null>;
  clearError: () => void;
}

/**
 * Jobs store for managing job state and operations.
 * Provides actions for CRUD operations and job lifecycle management.
 */
export const useJobsStore = create<JobsState>((set, get) => ({
  jobs: [],
  selectedJob: null,
  loading: false,
  error: null,
  page: 1,
  totalPages: 0,
  triggering: [],

  fetchJobs: async (page = 1) => {
    set({ loading: true, error: null });
    try {
      const result = await api.getJobs(page, 20, undefined, true);
      set({
        jobs: result.items,
        page: result.page,
        totalPages: result.total_pages,
        loading: false,
      });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  fetchJob: async (id: string) => {
    set({ loading: true, error: null });
    try {
      const job = await api.getJob(id);
      set({ selectedJob: job, loading: false });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  createJob: async (input, idempotencyKey) => {
    const job = await api.createJob(input, idempotencyKey);
    await get().fetchJobs(get().page);
    return job;
  },

  updateJob: async (id, input) => {
    set({ loading: true, error: null });
    try {
      const job = await api.updateJob(id, input);
      if (job) {
        await get().fetchJobs(get().page);
      }
      set({ loading: false });
      return job;
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
      return null;
    }
  },

  deleteJob: async (id: string) => {
    set({ loading: true, error: null });
    try {
      const success = await api.deleteJob(id);
      if (success) {
        await get().fetchJobs(get().page);
      }
      set({ loading: false });
      return success;
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
      return false;
    }
  },

  pauseJob: async (id: string) => {
    try {
      await api.pauseJob(id);
      await get().fetchJobs(get().page);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  resumeJob: async (id: string) => {
    try {
      await api.resumeJob(id);
      await get().fetchJobs(get().page);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  triggerJob: async (id: string) => {
    if (get().triggering.includes(id)) {
      return null;
    }
    set({ triggering: [...get().triggering, id], error: null });
    try {
      const result = await withIdempotentRetry((key) => api.triggerJob(id, key));
      await get().fetchJobs(get().page);
      return result.execution;
    } catch (error) {
      set({ error: (error as Error).message });
      return null;
    } finally {
      set({ triggering: get().triggering.filter((jobId) => jobId !== id) });
    }
  },

  clearError: () => set({ error: null }),
}));

/**
 * Metrics state interface.
 * Manages system metrics and worker information.
 */
interface MetricsState {
  metrics: SystemMetrics | null;
  workers: Worker[];
  loading: boolean;
  error: string | null;
  fetchMetrics: () => Promise<void>;
  fetchWorkers: () => Promise<void>;
}

/**
 * Metrics store for dashboard data.
 * Provides system-wide metrics and worker status information.
 */
export const useMetricsStore = create<MetricsState>((set) => ({
  metrics: null,
  workers: [],
  loading: false,
  error: null,

  fetchMetrics: async () => {
    set({ loading: true, error: null });
    try {
      const metrics = await api.getMetrics();
      set({ metrics, loading: false });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  fetchWorkers: async () => {
    try {
      const workers = await api.getWorkers();
      set({ workers });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },
}));

/**
 * Executions state interface.
 * Manages execution list, details, and operations.
 */
interface ExecutionsState {
  executions: JobExecution[];
  selectedExecution: JobExecution | null;
  loading: boolean;
  error: string | null;
  page: number;
  totalPages: number;
  fetchExecutions: (jobId?: string, page?: number) => Promise<void>;
  fetchExecution: (id: string) => Promise<void>;
  cancelExecution: (id: string) => Promise<void>;
  retryExecution: (id: string) => Promise<void>;
  clearError: () => void;
}

/**
 * Executions store for managing execution state.
 * Provides actions for viewing and managing job executions.
 */
export const useExecutionsStore = create<ExecutionsState>((set) => ({
  executions: [],
  selectedExecution: null,
  loading: false,
  error: null,
  page: 1,
  totalPages: 0,

  fetchExecutions: async (jobId?: string, page = 1) => {
    set({ loading: true, error: null });
    try {
      const result = await api.getExecutions(jobId, page);
      set({
        executions: result.items,
        page: result.page,
        totalPages: result.total_pages,
        loading: false,
      });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  fetchExecution: async (id: string) => {
    set({ loading: true, error: null });
    try {
      const execution = await api.getExecution(id);
      set({ selectedExecution: execution, loading: false });
    } catch (error) {
      set({ error: (error as Error).message, loading: false });
    }
  },

  cancelExecution: async (id: string) => {
    set({ error: null });
    try {
      await api.cancelExecution(id);
      await refreshAfterChange(id);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  retryExecution: async (id: string) => {
    set({ error: null });
    try {
      await withIdempotentRetry((key) => api.retryExecution(id, key));
      await refreshAfterChange(id);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  clearError: () => set({ error: null }),
}));

/** Re-reads whatever view shows the changed execution: its detail page and/or its job's list. */
async function refreshAfterChange(executionId: string): Promise<void> {
  const { selectedExecution, executions, page, fetchExecution, fetchExecutions } =
    useExecutionsStore.getState();
  const listed = executions.find((execution) => execution.id === executionId);
  await Promise.all([
    selectedExecution?.id === executionId ? fetchExecution(executionId) : Promise.resolve(),
    listed ? fetchExecutions(listed.job_id, page) : Promise.resolve(),
  ]);
}

/**
 * Authentication state interface.
 * Manages the current session and login/logout transitions.
 */
interface AuthState {
  user: api.AuthUser | null;
  /** False until the initial session-restore call has completed. */
  authChecked: boolean;
  loggingIn: boolean;
  error: string | null;
  checkSession: () => Promise<void>;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * Auth store backing the login screen and the route guard.
 *
 * `authChecked` is deliberately separate from `loggingIn`: the guard must wait
 * for the session-restore round trip before deciding a user is logged out,
 * otherwise every reload flashes the login screen for an already-valid session.
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  authChecked: false,
  loggingIn: false,
  error: null,

  checkSession: async () => {
    const user = await api.getCurrentUser();
    set({ user, authChecked: true });
  },

  login: async (username, password) => {
    set({ loggingIn: true, error: null });
    try {
      const user = await api.login(username, password);
      set({ user, loggingIn: false, authChecked: true });
    } catch (error) {
      set({ error: (error as Error).message, loggingIn: false });
      throw error;
    }
  },

  logout: async () => {
    await api.logout();
    set({ user: null });
  },
}));
