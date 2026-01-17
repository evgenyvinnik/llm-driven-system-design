import { create } from 'zustand';
import type { Dashboard, TimeRange, TIME_RANGE_OPTIONS } from '../types';

interface DashboardState {
  dashboards: Dashboard[];
  currentDashboard: Dashboard | null;
  timeRange: TimeRange;
  refreshInterval: number;
  isLoading: boolean;
  error: string | null;
  setDashboards: (dashboards: Dashboard[]) => void;
  setCurrentDashboard: (dashboard: Dashboard | null) => void;
  setTimeRange: (range: TimeRange) => void;
  setRefreshInterval: (interval: number) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

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
