import { create } from 'zustand';
import { cacheApi } from '../services/api';
import type { ClusterInfo, ClusterStats, KeysResponse } from '../types';

interface CacheStore {
  // State
  clusterInfo: ClusterInfo | null;
  clusterStats: ClusterStats | null;
  keys: KeysResponse | null;
  isLoading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  autoRefresh: boolean;

  // Actions
  fetchClusterInfo: () => Promise<void>;
  fetchClusterStats: () => Promise<void>;
  fetchKeys: (pattern?: string) => Promise<void>;
  refreshAll: () => Promise<void>;
  setAutoRefresh: (enabled: boolean) => void;
  clearError: () => void;
}

export const useCacheStore = create<CacheStore>((set, get) => ({
  clusterInfo: null,
  clusterStats: null,
  keys: null,
  isLoading: false,
  error: null,
  lastUpdated: null,
  autoRefresh: true,

  fetchClusterInfo: async () => {
    try {
      const info = await cacheApi.getClusterInfo();
      set({ clusterInfo: info, lastUpdated: new Date() });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch cluster info' });
    }
  },

  fetchClusterStats: async () => {
    try {
      const stats = await cacheApi.getClusterStats();
      set({ clusterStats: stats, lastUpdated: new Date() });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch cluster stats' });
    }
  },

  fetchKeys: async (pattern = '*') => {
    try {
      const keys = await cacheApi.getKeys(pattern);
      set({ keys, lastUpdated: new Date() });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch keys' });
    }
  },

  refreshAll: async () => {
    set({ isLoading: true, error: null });
    try {
      await Promise.all([get().fetchClusterInfo(), get().fetchClusterStats(), get().fetchKeys()]);
    } finally {
      set({ isLoading: false });
    }
  },

  setAutoRefresh: (enabled) => set({ autoRefresh: enabled }),

  clearError: () => set({ error: null }),
}));
