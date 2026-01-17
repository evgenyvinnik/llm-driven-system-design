import { create } from 'zustand';
import type { SystemStats, RealTimeStats, Campaign, Ad, ClickEvent } from '../types';
import { getSystemStats, getRealTimeStats, getCampaigns, getAds, getRecentClicks } from '../services/api';

interface DashboardState {
  stats: SystemStats | null;
  realTimeStats: RealTimeStats | null;
  campaigns: Campaign[];
  ads: Ad[];
  recentClicks: ClickEvent[];
  isLoading: boolean;
  error: string | null;
  lastUpdated: Date | null;

  fetchStats: () => Promise<void>;
  fetchRealTimeStats: (minutes?: number) => Promise<void>;
  fetchCampaigns: () => Promise<void>;
  fetchAds: () => Promise<void>;
  fetchRecentClicks: (limit?: number, fraudOnly?: boolean) => Promise<void>;
  refreshAll: () => Promise<void>;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  stats: null,
  realTimeStats: null,
  campaigns: [],
  ads: [],
  recentClicks: [],
  isLoading: false,
  error: null,
  lastUpdated: null,

  fetchStats: async () => {
    try {
      const stats = await getSystemStats();
      set({ stats, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch stats' });
    }
  },

  fetchRealTimeStats: async (minutes = 60) => {
    try {
      const realTimeStats = await getRealTimeStats(minutes);
      set({ realTimeStats, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch real-time stats' });
    }
  },

  fetchCampaigns: async () => {
    try {
      const { campaigns } = await getCampaigns();
      set({ campaigns, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch campaigns' });
    }
  },

  fetchAds: async () => {
    try {
      const { ads } = await getAds();
      set({ ads, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch ads' });
    }
  },

  fetchRecentClicks: async (limit = 100, fraudOnly = false) => {
    try {
      const { clicks } = await getRecentClicks(limit, fraudOnly);
      set({ recentClicks: clicks, error: null });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch recent clicks' });
    }
  },

  refreshAll: async () => {
    set({ isLoading: true });
    const state = get();

    await Promise.all([
      state.fetchStats(),
      state.fetchRealTimeStats(),
      state.fetchCampaigns(),
      state.fetchAds(),
      state.fetchRecentClicks(),
    ]);

    set({ isLoading: false, lastUpdated: new Date() });
  },
}));
