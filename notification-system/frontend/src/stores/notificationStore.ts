import { create } from 'zustand';
import { api } from '../services/api';
import type { Notification, Preferences, RateLimitUsage } from '../types';

interface NotificationState {
  notifications: Notification[];
  preferences: Preferences | null;
  rateLimitUsage: RateLimitUsage | null;
  isLoading: boolean;
  error: string | null;
  fetchNotifications: (options?: { limit?: number; offset?: number; status?: string }) => Promise<void>;
  fetchPreferences: () => Promise<void>;
  updatePreferences: (updates: Partial<Preferences>) => Promise<void>;
  setQuietHours: (start: string | null, end: string | null, enabled: boolean) => Promise<void>;
  fetchRateLimitUsage: () => Promise<void>;
  sendNotification: (data: {
    userId?: string;
    templateId?: string;
    data?: Record<string, unknown>;
    channels?: string[];
    priority?: string;
  }) => Promise<{ notificationId: string; status: string }>;
  cancelNotification: (id: string) => Promise<void>;
  clearError: () => void;
}

export const useNotificationStore = create<NotificationState>((set, get) => ({
  notifications: [],
  preferences: null,
  rateLimitUsage: null,
  isLoading: false,
  error: null,

  fetchNotifications: async (options) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.getNotifications(options);
      set({ notifications: response.notifications as Notification[], isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch notifications',
      });
    }
  },

  fetchPreferences: async () => {
    set({ isLoading: true, error: null });
    try {
      const preferences = await api.getPreferences();
      set({ preferences: preferences as Preferences, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to fetch preferences',
      });
    }
  },

  updatePreferences: async (updates) => {
    set({ isLoading: true, error: null });
    try {
      const preferences = await api.updatePreferences(updates);
      set({ preferences: preferences as Preferences, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to update preferences',
      });
      throw error;
    }
  },

  setQuietHours: async (start, end, enabled) => {
    set({ isLoading: true, error: null });
    try {
      const preferences = await api.setQuietHours(start, end, enabled);
      set({ preferences: preferences as Preferences, isLoading: false });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to set quiet hours',
      });
      throw error;
    }
  },

  fetchRateLimitUsage: async () => {
    try {
      const response = await api.getRateLimitUsage();
      set({ rateLimitUsage: response.usage as RateLimitUsage });
    } catch (error) {
      console.error('Failed to fetch rate limit usage:', error);
    }
  },

  sendNotification: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const result = await api.sendNotification(data);
      set({ isLoading: false });
      // Refresh notifications list
      get().fetchNotifications();
      return result;
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to send notification',
      });
      throw error;
    }
  },

  cancelNotification: async (id) => {
    set({ isLoading: true, error: null });
    try {
      await api.cancelNotification(id);
      set({ isLoading: false });
      get().fetchNotifications();
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to cancel notification',
      });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
