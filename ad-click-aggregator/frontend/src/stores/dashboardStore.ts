/**
 * @fileoverview Zustand store for dashboard state management.
 * Centralizes data fetching and state for the analytics dashboard.
 * Provides reactive state updates and automatic refresh capabilities.
 */

import { create } from 'zustand';
import type { SystemStats, RealTimeStats, Campaign, Ad, ClickEvent } from '../types';
import { getSystemStats, getRealTimeStats, getCampaigns, getAds, getRecentClicks } from '../services/api';

/**
 * Dashboard state interface defining all managed data and actions.
 */
interface DashboardState {
  /** System-wide statistics (totals, fraud rates) */
  stats: SystemStats | null;
  /** Real-time click statistics (time series) */
  realTimeStats: RealTimeStats | null;
  /** List of all campaigns */
  campaigns: Campaign[];
  /** List of all ads */
  ads: Ad[];
  /** Recent click events for monitoring */
  recentClicks: ClickEvent[];
  /** Loading state for async operations */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;
  /** Timestamp of last successful refresh */
  lastUpdated: Date | null;

  /** Fetches system-wide statistics */
  fetchStats: () => Promise<void>;
  /** Fetches real-time click statistics */
  fetchRealTimeStats: (minutes?: number) => Promise<void>;
  /** Fetches campaign list */
  fetchCampaigns: () => Promise<void>;
  /** Fetches ad list */
  fetchAds: () => Promise<void>;
  /** Fetches recent click events */
  fetchRecentClicks: (limit?: number, fraudOnly?: boolean) => Promise<void>;
  /** Refreshes all dashboard data */
  refreshAll: () => Promise<void>;
}

/**
 * Dashboard store with actions for fetching and managing analytics data.
 * Uses Zustand for simple, performant state management.
 */
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
