// Zustand store for Rate Limiter state

import { create } from 'zustand';
import type { Algorithm, Metrics, HealthStatus, AlgorithmInfo, TestResult } from '../types';
import { api } from '../services/api';

interface RateLimiterState {
  // Test configuration
  identifier: string;
  algorithm: Algorithm;
  limit: number;
  windowSeconds: number;
  burstCapacity: number;
  refillRate: number;
  leakRate: number;

  // Test results
  testResults: TestResult[];
  isRunning: boolean;
  autoTestInterval: number | null;

  // Metrics and health
  metrics: Metrics | null;
  health: HealthStatus | null;
  algorithms: AlgorithmInfo[];

  // Actions
  setIdentifier: (identifier: string) => void;
  setAlgorithm: (algorithm: Algorithm) => void;
  setLimit: (limit: number) => void;
  setWindowSeconds: (windowSeconds: number) => void;
  setBurstCapacity: (burstCapacity: number) => void;
  setRefillRate: (refillRate: number) => void;
  setLeakRate: (leakRate: number) => void;

  runTest: () => Promise<void>;
  startAutoTest: (intervalMs: number) => void;
  stopAutoTest: () => void;
  clearResults: () => void;
  resetRateLimit: () => Promise<void>;

  fetchMetrics: () => Promise<void>;
  fetchHealth: () => Promise<void>;
  fetchAlgorithms: () => Promise<void>;
}

export const useRateLimiterStore = create<RateLimiterState>((set, get) => ({
  // Default values
  identifier: 'test-user-1',
  algorithm: 'sliding_window',
  limit: 10,
  windowSeconds: 60,
  burstCapacity: 10,
  refillRate: 1,
  leakRate: 1,

  testResults: [],
  isRunning: false,
  autoTestInterval: null,

  metrics: null,
  health: null,
  algorithms: [],

  // Setters
  setIdentifier: (identifier) => set({ identifier }),
  setAlgorithm: (algorithm) => set({ algorithm }),
  setLimit: (limit) => set({ limit }),
  setWindowSeconds: (windowSeconds) => set({ windowSeconds }),
  setBurstCapacity: (burstCapacity) => set({ burstCapacity }),
  setRefillRate: (refillRate) => set({ refillRate }),
  setLeakRate: (leakRate) => set({ leakRate }),

  // Run a single test
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

      set((prev) => ({
        testResults: [testResult, ...prev.testResults.slice(0, 99)],
      }));
    } catch (error) {
      console.error('Test failed:', error);
    } finally {
      set({ isRunning: false });
    }
  },

  // Start auto test at interval
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

  stopAutoTest: () => {
    const state = get();
    if (state.autoTestInterval !== null) {
      clearInterval(state.autoTestInterval);
      set({ autoTestInterval: null });
    }
  },

  clearResults: () => set({ testResults: [] }),

  resetRateLimit: async () => {
    const state = get();
    try {
      await api.resetRateLimit(state.identifier);
      set({ testResults: [] });
    } catch (error) {
      console.error('Reset failed:', error);
    }
  },

  fetchMetrics: async () => {
    try {
      const metrics = await api.getMetrics();
      set({ metrics });
    } catch (error) {
      console.error('Failed to fetch metrics:', error);
    }
  },

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

  fetchAlgorithms: async () => {
    try {
      const response = await api.getAlgorithms();
      set({ algorithms: response.algorithms });
    } catch (error) {
      console.error('Failed to fetch algorithms:', error);
    }
  },
}));
