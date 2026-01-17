/**
 * Zustand store for alert notification state management.
 * Handles fetching, reading, and deleting price drop alerts.
 * @module stores/alertStore
 */
import { create } from 'zustand';
import { Alert } from '../types';
import * as alertService from '../services/alerts';

/**
 * Alert state shape.
 */
interface AlertState {
  /** List of alert notifications */
  alerts: Alert[];
  /** Count of unread alerts for badge */
  unreadCount: number;
  /** True while loading alerts */
  isLoading: boolean;
  /** Error message if operation failed */
  error: string | null;
  /** Fetches all alerts, optionally filtered to unread only */
  fetchAlerts: (unreadOnly?: boolean) => Promise<void>;
  /** Fetches just the unread count for badge display */
  fetchUnreadCount: () => Promise<void>;
  /** Marks a single alert as read */
  markAsRead: (alertId: string) => Promise<void>;
  /** Marks all alerts as read */
  markAllAsRead: () => Promise<void>;
  /** Deletes an alert */
  deleteAlert: (alertId: string) => Promise<void>;
}

/**
 * Global alert store.
 * Use with: const { alerts, unreadCount, fetchAlerts } = useAlertStore();
 */
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
