import { create } from 'zustand';
import { Alert } from '../types';
import * as alertService from '../services/alerts';

interface AlertState {
  alerts: Alert[];
  unreadCount: number;
  isLoading: boolean;
  error: string | null;
  fetchAlerts: (unreadOnly?: boolean) => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  markAsRead: (alertId: string) => Promise<void>;
  markAllAsRead: () => Promise<void>;
  deleteAlert: (alertId: string) => Promise<void>;
}

export const useAlertStore = create<AlertState>((set, get) => ({
  alerts: [],
  unreadCount: 0,
  isLoading: false,
  error: null,

  fetchAlerts: async (unreadOnly = false) => {
    set({ isLoading: true, error: null });
    try {
      const alerts = await alertService.getAlerts(unreadOnly);
      set({ alerts, isLoading: false });
    } catch {
      set({ error: 'Failed to fetch alerts', isLoading: false });
    }
  },

  fetchUnreadCount: async () => {
    try {
      const count = await alertService.getUnreadCount();
      set({ unreadCount: count });
    } catch {
      // Silently fail
    }
  },

  markAsRead: async (alertId: string) => {
    await alertService.markAsRead(alertId);
    set((state) => ({
      alerts: state.alerts.map((a) =>
        a.id === alertId ? { ...a, is_read: true } : a
      ),
      unreadCount: Math.max(0, state.unreadCount - 1),
    }));
  },

  markAllAsRead: async () => {
    await alertService.markAllAsRead();
    set((state) => ({
      alerts: state.alerts.map((a) => ({ ...a, is_read: true })),
      unreadCount: 0,
    }));
  },

  deleteAlert: async (alertId: string) => {
    await alertService.deleteAlert(alertId);
    set((state) => ({
      alerts: state.alerts.filter((a) => a.id !== alertId),
    }));
  },
}));
