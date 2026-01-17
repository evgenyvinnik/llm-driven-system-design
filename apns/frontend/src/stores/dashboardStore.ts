/**
 * Dashboard Store.
 *
 * Manages dashboard statistics state using Zustand.
 * Fetches and caches aggregate data for the admin dashboard overview.
 *
 * @module stores/dashboardStore
 */

import { create } from 'zustand';
import { adminApi } from '../services/api';

/**
 * Aggregate notification statistics.
 */
interface NotificationStats {
  /** Total notifications ever created */
  total: number;
  /** Notifications awaiting processing */
  pending: number;
  /** Notifications queued for offline devices */
  queued: number;
  /** Successfully delivered notifications */
  delivered: number;
  /** Failed delivery attempts */
  failed: number;
  /** Notifications that expired before delivery */
  expired: number;
}

/**
 * Aggregate device statistics.
 */
interface DeviceStats {
  /** Total registered devices */
  total: number;
  /** Devices with valid tokens */
  valid: number;
  /** Devices with invalidated tokens */
  invalid: number;
}

/**
 * Per-topic subscriber count.
 */
interface TopicStats {
  /** Topic name */
  topic: string;
  /** Number of valid subscribers */
  subscriber_count: number;
}

/**
 * Recent notification for activity feed.
 */
interface RecentNotification {
  /** Notification UUID */
  id: string;
  /** Target device ID */
  device_id: string;
  /** Current status */
  status: string;
  /** Creation timestamp */
  created_at: string;
  /** Notification payload */
  payload: unknown;
}

/**
 * Dashboard store state and actions.
 */
interface DashboardState {
  /** Notification delivery statistics */
  notifications: NotificationStats;
  /** Device registration statistics */
  devices: DeviceStats;
  /** Per-topic subscriber counts */
  topics: TopicStats[];
  /** Recent notifications for activity feed */
  recentNotifications: RecentNotification[];
  /** Whether data is being fetched */
  isLoading: boolean;
  /** Error message from last failed fetch */
  error: string | null;
  /** Fetch fresh statistics from the backend. */
  fetchStats: () => Promise<void>;
}

/**
 * Zustand store for dashboard statistics.
 * Provides cached data and async refresh capability.
 */
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
