import { create } from 'zustand';
import type {
  DailySummary,
  WeeklySummary,
  LatestMetrics,
  HealthInsight,
  HealthAggregate,
  Device,
} from '../types';
import { api } from '../services/api';

interface HealthState {
  dailySummary: DailySummary | null;
  weeklySummary: WeeklySummary | null;
  latestMetrics: LatestMetrics | null;
  insights: HealthInsight[];
  history: Record<string, HealthAggregate[]>;
  devices: Device[];
  isLoading: boolean;
  error: string | null;

  fetchDailySummary: (date?: string) => Promise<void>;
  fetchWeeklySummary: () => Promise<void>;
  fetchLatestMetrics: () => Promise<void>;
  fetchInsights: () => Promise<void>;
  fetchHistory: (type: string, days?: number) => Promise<void>;
  fetchDevices: () => Promise<void>;
  analyzeHealth: () => Promise<void>;
  acknowledgeInsight: (insightId: string) => Promise<void>;
  clearError: () => void;
}

export const useHealthStore = create<HealthState>((set, get) => ({
  dailySummary: null,
  weeklySummary: null,
  latestMetrics: null,
  insights: [],
  history: {},
  devices: [],
  isLoading: false,
  error: null,

  fetchDailySummary: async (date?: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.health.dailySummary(date);
      set({ dailySummary: response.summary, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch daily summary',
        isLoading: false,
      });
    }
  },

  fetchWeeklySummary: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.health.weeklySummary();
      set({ weeklySummary: response.summary, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch weekly summary',
        isLoading: false,
      });
    }
  },

  fetchLatestMetrics: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.health.latest();
      set({ latestMetrics: response.metrics, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch latest metrics',
        isLoading: false,
      });
    }
  },

  fetchInsights: async () => {
    try {
      const response = await api.health.insights(10, false);
      set({ insights: response.insights });
    } catch (error) {
      console.error('Failed to fetch insights:', error);
    }
  },

  fetchHistory: async (type: string, days = 30) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.health.history(type, days);
      set((state) => ({
        history: { ...state.history, [type]: response.history },
        isLoading: false,
      }));
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch history',
        isLoading: false,
      });
    }
  },

  fetchDevices: async () => {
    try {
      const response = await api.devices.list();
      set({ devices: response.devices });
    } catch (error) {
      console.error('Failed to fetch devices:', error);
    }
  },

  analyzeHealth: async () => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.health.analyze();
      set({ insights: response.insights, isLoading: false });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to analyze health',
        isLoading: false,
      });
    }
  },

  acknowledgeInsight: async (insightId: string) => {
    try {
      await api.health.acknowledgeInsight(insightId);
      set((state) => ({
        insights: state.insights.map((i) =>
          i.id === insightId ? { ...i, acknowledged: true } : i
        ),
      }));
    } catch (error) {
      console.error('Failed to acknowledge insight:', error);
    }
  },

  clearError: () => set({ error: null }),
}));
