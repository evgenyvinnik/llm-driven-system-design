/**
 * Zustand stores for global application state management.
 * Provides reactive state for jobs, executions, and system metrics.
 * @module stores
 */

import { create } from 'zustand';
import { Job, JobWithStats, JobExecution, SystemMetrics, Worker } from '../types';
import * as api from '../services/api';

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
  fetchJobs: (page?: number) => Promise<void>;
  fetchJob: (id: string) => Promise<void>;
  createJob: (input: Parameters<typeof api.createJob>[0]) => Promise<Job | null>;
  updateJob: (id: string, input: Parameters<typeof api.updateJob>[1]) => Promise<Job | null>;
  deleteJob: (id: string) => Promise<boolean>;
  pauseJob: (id: string) => Promise<void>;
  resumeJob: (id: string) => Promise<void>;
  triggerJob: (id: string) => Promise<JobExecution | null>;
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

  createJob: async (input) => {
    set({ loading: true, error: null });
    try {
      const job = await api.createJob(input);
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
    try {
      const result = await api.triggerJob(id);
      await get().fetchJobs(get().page);
      return result?.execution || null;
    } catch (error) {
      set({ error: (error as Error).message });
      return null;
    }
  },
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
}

/**
 * Executions store for managing execution state.
 * Provides actions for viewing and managing job executions.
 */
export const useExecutionsStore = create<ExecutionsState>((set, get) => ({
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
    try {
      await api.cancelExecution(id);
      await get().fetchExecution(id);
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  retryExecution: async (id: string) => {
    try {
      await api.retryExecution(id);
      // Refresh executions list
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },
}));
