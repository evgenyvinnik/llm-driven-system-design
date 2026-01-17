import { create } from 'zustand';
import { api, DashboardData } from '../services/api';
import { useAuthStore } from './auth';

interface DashboardState {
  data: DashboardData | null;
  lbStatus: unknown;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  autoRefresh: boolean;
  refreshInterval: number;
  fetchDashboard: () => Promise<void>;
  fetchLbStatus: () => Promise<void>;
  setAutoRefresh: (enabled: boolean) => void;
  setRefreshInterval: (interval: number) => void;
}

export const useDashboardStore = create<DashboardState>((set, get) => ({
  data: null,
  lbStatus: null,
  loading: false,
  error: null,
  lastUpdated: null,
  autoRefresh: true,
  refreshInterval: 5000,

  fetchDashboard: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;

    set({ loading: true });
    try {
      const data = await api.getDashboard(token);
      set({
        data,
        loading: false,
        error: null,
        lastUpdated: new Date(),
      });
    } catch (error) {
      set({
        loading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch dashboard',
      });
    }
  },

  fetchLbStatus: async () => {
    try {
      const response = await fetch('/lb/status');
      if (response.ok) {
        const data = await response.json();
        set({ lbStatus: data });
      }
    } catch {
      // LB might not be running
    }
  },

  setAutoRefresh: (enabled: boolean) => set({ autoRefresh: enabled }),
  setRefreshInterval: (interval: number) => set({ refreshInterval: interval }),
}));
