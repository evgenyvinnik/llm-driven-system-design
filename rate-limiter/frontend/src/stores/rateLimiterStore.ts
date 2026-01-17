/**
 * @fileoverview Zustand store for Rate Limiter application state.
 *
 * Manages all frontend state including test configuration, test results,
 * metrics, and health status. Provides actions for running tests,
 * managing auto-test intervals, and fetching data from the backend.
 */

import { create } from 'zustand';
import type { Algorithm, Metrics, HealthStatus, AlgorithmInfo, TestResult } from '../types';
import { api } from '../services/api';

/**
 * State and actions interface for the rate limiter store.
 * Combines configuration state, test results, and action methods.
 */
interface RateLimiterState {
  // Test configuration
  /** Current identifier for rate limit testing */
  identifier: string;
  /** Selected rate limiting algorithm */
  algorithm: Algorithm;
  /** Maximum requests per window (for window-based algorithms) */
  limit: number;
  /** Window duration in seconds */
  windowSeconds: number;
  /** Bucket capacity for bucket-based algorithms */
  burstCapacity: number;
  /** Token refill rate (tokens/second) for token bucket */
  refillRate: number;
  /** Leak rate (requests/second) for leaky bucket */
  leakRate: number;

  // Test results
  /** Array of test results (newest first) */
  testResults: TestResult[];
  /** Whether a test is currently running */
  isRunning: boolean;
  /** Interval ID for auto-testing (null if not running) */
  autoTestInterval: number | null;

  // Metrics and health
  /** Latest metrics from the backend */
  metrics: Metrics | null;
  /** Latest health status from the backend */
  health: HealthStatus | null;
  /** Available algorithms with documentation */
  algorithms: AlgorithmInfo[];

  // Configuration setters
  setIdentifier: (identifier: string) => void;
  setAlgorithm: (algorithm: Algorithm) => void;
  setLimit: (limit: number) => void;
  setWindowSeconds: (windowSeconds: number) => void;
  setBurstCapacity: (burstCapacity: number) => void;
  setRefillRate: (refillRate: number) => void;
  setLeakRate: (leakRate: number) => void;

  // Test actions
  /** Run a single rate limit test */
  runTest: () => Promise<void>;
  /** Start automatic testing at specified interval */
  startAutoTest: (intervalMs: number) => void;
  /** Stop automatic testing */
  stopAutoTest: () => void;
  /** Clear all test results */
  clearResults: () => void;
  /** Reset rate limit for current identifier */
  resetRateLimit: () => Promise<void>;

  // Data fetching
  /** Fetch latest metrics from backend */
  fetchMetrics: () => Promise<void>;
  /** Fetch health status from backend */
  fetchHealth: () => Promise<void>;
  /** Fetch available algorithms from backend */
  fetchAlgorithms: () => Promise<void>;
}

/**
 * Zustand store for the rate limiter application.
 * Provides centralized state management with async actions.
 */
export const useRateLimiterStore = create<RateLimiterState>((set, get) => ({
  // Default configuration values
  identifier: 'test-user-1',
  algorithm: 'sliding_window',
  limit: 10,
  windowSeconds: 60,
  burstCapacity: 10,
  refillRate: 1,
  leakRate: 1,

  // Initial state
  testResults: [],
  isRunning: false,
  autoTestInterval: null,

  metrics: null,
  health: null,
  algorithms: [],

  // Configuration setters - simple state updates
  setIdentifier: (identifier) => set({ identifier }),
  setAlgorithm: (algorithm) => set({ algorithm }),
  setLimit: (limit) => set({ limit }),
  setWindowSeconds: (windowSeconds) => set({ windowSeconds }),
  setBurstCapacity: (burstCapacity) => set({ burstCapacity }),
  setRefillRate: (refillRate) => set({ refillRate }),
  setLeakRate: (leakRate) => set({ leakRate }),

  /**
   * Run a single rate limit test against the backend.
   * Adds the result to the test results list (max 100 results kept).
   */
  runTest: async () => {
    const state = get();
    set({ isRunning: true });

    try {
      const result = await api.checkRateLimit({
        identifier: state.identifier,
        algorithm: state.algorithm,
        limit: state.limit,
        windowSeconds: state.windowSeconds,
        burstCapacity: state.burstCapacity,
        refillRate: state.refillRate,
        leakRate: state.leakRate,
      });

      const testResult: TestResult = {
        timestamp: Date.now(),
        identifier: state.identifier,
        algorithm: state.algorithm,
        allowed: result.allowed,
        remaining: result.remaining,
        limit: result.limit,
        latencyMs: result.latencyMs || 0,
      };

      // Keep only the last 100 results
      set((prev) => ({
        testResults: [testResult, ...prev.testResults.slice(0, 99)],
      }));
    } catch (error) {
      console.error('Test failed:', error);
    } finally {
      set({ isRunning: false });
    }
  },

  /**
   * Start automatic testing at a specified interval.
   * Clears any existing interval before starting a new one.
   *
   * @param intervalMs - Time between tests in milliseconds
   */
  startAutoTest: (intervalMs) => {
    const state = get();
    if (state.autoTestInterval !== null) {
      clearInterval(state.autoTestInterval);
    }

    const interval = window.setInterval(() => {
      get().runTest();
    }, intervalMs);

    set({ autoTestInterval: interval as unknown as number });
  },

  /**
   * Stop automatic testing and clear the interval.
   */
  stopAutoTest: () => {
    const state = get();
    if (state.autoTestInterval !== null) {
      clearInterval(state.autoTestInterval);
      set({ autoTestInterval: null });
    }
  },

  /**
   * Clear all test results from the display.
   */
  clearResults: () => set({ testResults: [] }),

  /**
   * Reset rate limit for the current identifier.
   * Also clears test results for a fresh start.
   */
  resetRateLimit: async () => {
    const state = get();
    try {
      await api.resetRateLimit(state.identifier);
      set({ testResults: [] });
    } catch (error) {
      console.error('Reset failed:', error);
    }
  },

  /**
   * Fetch latest metrics from the backend.
   * Updates the metrics state on success.
   */
  fetchMetrics: async () => {
    try {
      const metrics = await api.getMetrics();
      set({ metrics });
    } catch (error) {
      console.error('Failed to fetch metrics:', error);
    }
  },

  /**
   * Fetch health status from the backend.
   * Sets unhealthy state if the request fails.
   */
  fetchHealth: async () => {
    try {
      const health = await api.getHealth();
      set({ health });
    } catch (error) {
      set({
        health: {
          status: 'unhealthy',
          redis: { connected: false, error: 'Failed to connect' },
          uptime: 0,
          timestamp: Date.now(),
        },
      });
    }
  },

  /**
   * Fetch available algorithms from the backend.
   * Updates the algorithms list for the selector component.
   */
  fetchAlgorithms: async () => {
    try {
      const response = await api.getAlgorithms();
      set({ algorithms: response.algorithms });
    } catch (error) {
      console.error('Failed to fetch algorithms:', error);
    }
  },
}));
