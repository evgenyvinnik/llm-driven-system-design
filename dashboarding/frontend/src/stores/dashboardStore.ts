/**
 * @fileoverview Zustand store for dashboard state management.
 *
 * Manages the dashboard list, current selection, time range for queries,
 * and refresh settings. Provides a centralized store for dashboard-related
 * UI state that persists across route navigation.
 */

import { create } from 'zustand';
import type { Dashboard, TimeRange, TIME_RANGE_OPTIONS } from '../types';

/**
 * Dashboard store state and actions interface.
 */
interface DashboardState {
  /** All loaded dashboards */
  dashboards: Dashboard[];
  /** Currently selected dashboard for viewing/editing */
  currentDashboard: Dashboard | null;
  /** Selected time range for all panels (e.g., '1h', '24h') */
  timeRange: TimeRange;
  /** Auto-refresh interval in milliseconds */
  refreshInterval: number;
  /** Whether dashboard data is currently being fetched */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;

  /**
   * Sets the list of available dashboards.
   * @param dashboards - Dashboards to store
   */
  setDashboards: (dashboards: Dashboard[]) => void;

  /**
   * Sets the currently active dashboard.
   * @param dashboard - The dashboard to select, or null to clear
   */
  setCurrentDashboard: (dashboard: Dashboard | null) => void;

  /**
   * Sets the time range for metric queries.
   * @param range - Time range preset (e.g., '15m', '1h', '24h')
   */
  setTimeRange: (range: TimeRange) => void;

  /**
   * Sets the auto-refresh interval.
   * @param interval - Refresh interval in milliseconds
   */
  setRefreshInterval: (interval: number) => void;

  /**
   * Sets the loading state.
   * @param loading - Whether a fetch operation is in progress
   */
  setLoading: (loading: boolean) => void;

  /**
   * Sets the error state.
   * @param error - Error message or null to clear
   */
  setError: (error: string | null) => void;
}

/**
 * Zustand store for dashboard UI state.
 *
 * Default time range is '1h' (last hour) with 10-second refresh interval.
 */
export const useDashboardStore = create<DashboardState>((set) => ({
  dashboards: [],
  currentDashboard: null,
  timeRange: '1h',
  refreshInterval: 10000,
  isLoading: false,
  error: null,
  setDashboards: (dashboards) => set({ dashboards }),
  setCurrentDashboard: (dashboard) => set({ currentDashboard: dashboard }),
  setTimeRange: (timeRange) => set({ timeRange }),
  setRefreshInterval: (refreshInterval) => set({ refreshInterval }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),
}));
