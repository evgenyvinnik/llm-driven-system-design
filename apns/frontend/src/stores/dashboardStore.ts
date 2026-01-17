import { create } from 'zustand';
import { adminApi } from '../services/api';

interface NotificationStats {
  total: number;
  pending: number;
  queued: number;
  delivered: number;
  failed: number;
  expired: number;
}

interface DeviceStats {
  total: number;
  valid: number;
  invalid: number;
}

interface TopicStats {
  topic: string;
  subscriber_count: number;
}

interface RecentNotification {
  id: string;
  device_id: string;
  status: string;
  created_at: string;
  payload: unknown;
}

interface DashboardState {
  notifications: NotificationStats;
  devices: DeviceStats;
  topics: TopicStats[];
  recentNotifications: RecentNotification[];
  isLoading: boolean;
  error: string | null;
  fetchStats: () => Promise<void>;
}

export const useDashboardStore = create<DashboardState>()((set) => ({
  notifications: { total: 0, pending: 0, queued: 0, delivered: 0, failed: 0, expired: 0 },
  devices: { total: 0, valid: 0, invalid: 0 },
  topics: [],
  recentNotifications: [],
  isLoading: false,
  error: null,

  fetchStats: async () => {
    set({ isLoading: true, error: null });
    try {
      const stats = await adminApi.getStats();
      set({
        notifications: stats.notifications,
        devices: stats.devices,
        topics: stats.topics,
        recentNotifications: stats.recent_notifications,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to fetch stats',
        isLoading: false,
      });
    }
  },
}));
