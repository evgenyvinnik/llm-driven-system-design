/**
 * Global state management store for the Find My application.
 * Uses Zustand for lightweight, hook-based state management.
 * Handles authentication, device management, location tracking, and notifications.
 */

import { create } from 'zustand';
import { User, Device, Location, LostMode, Notification } from '../types';
import { authApi, devicesApi, locationsApi, lostModeApi, notificationsApi } from '../services/api';

/**
 * Application state and actions interface.
 * Defines all state properties and action methods available in the store.
 */
interface AppState {
  // Auth state
  /** Currently authenticated user or null if not logged in */
  user: User | null;
  /** Global loading indicator for async operations */
  isLoading: boolean;
  /** Last error message for display to user */
  error: string | null;

  // Devices state
  /** List of user's registered devices */
  devices: Device[];
  /** Currently selected device for detail/map view */
  selectedDevice: Device | null;

  // Locations state
  /** Location history for the selected device */
  locations: Location[];

  // Lost Mode state
  /** Lost mode settings indexed by device ID */
  lostModeSettings: Record<string, LostMode>;

  // Notifications state
  /** List of user notifications */
  notifications: Notification[];
  /** Count of unread notifications for badge display */
  unreadCount: number;

  // Auth actions
  /** Authenticate with email and password */
  login: (email: string, password: string) => Promise<void>;
  /** Create a new user account */
  register: (email: string, password: string, name: string) => Promise<void>;
  /** End the current session */
  logout: () => Promise<void>;
  /** Check if user has a valid session on app load */
  checkAuth: () => Promise<void>;

  // Device actions
  /** Fetch all devices for the current user */
  fetchDevices: () => Promise<void>;
  /** Register a new device */
  createDevice: (data: { device_type: string; name: string; emoji?: string }) => Promise<Device>;
  /** Update device properties */
  updateDevice: (id: string, data: { name?: string; emoji?: string; is_active?: boolean }) => Promise<void>;
  /** Remove a device */
  deleteDevice: (id: string) => Promise<void>;
  /** Select a device to view details and location */
  selectDevice: (device: Device | null) => void;
  /** Trigger sound playback on a device */
  playSound: (id: string) => Promise<void>;

  // Location actions
  /** Fetch location history for a device */
  fetchLocations: (deviceId: string) => Promise<void>;
  /** Simulate a location report for testing */
  simulateLocation: (deviceId: string, location: { latitude: number; longitude: number }) => Promise<void>;

  // Lost Mode actions
  /** Fetch lost mode settings for a device */
  fetchLostMode: (deviceId: string) => Promise<void>;
  /** Update lost mode settings */
  updateLostMode: (deviceId: string, data: { enabled: boolean; contact_phone?: string; contact_email?: string; message?: string }) => Promise<void>;
  /** Quickly enable lost mode */
  enableLostMode: (deviceId: string) => Promise<void>;
  /** Turn off lost mode */
  disableLostMode: (deviceId: string) => Promise<void>;

  // Notification actions
  /** Fetch all notifications */
  fetchNotifications: () => Promise<void>;
  /** Fetch unread notification count */
  fetchUnreadCount: () => Promise<void>;
  /** Mark a single notification as read */
  markAsRead: (id: string) => Promise<void>;
  /** Mark all notifications as read */
  markAllAsRead: () => Promise<void>;

  // UI actions
  /** Clear the current error message */
  clearError: () => void;
}

/**
 * Main application store hook.
 * Provides all state and actions for the Find My frontend.
 */
export const useStore = create<AppState>((set, get) => ({
  // Initial state
  user: null,
  isLoading: false,
  error: null,
  devices: [],
  selectedDevice: null,
  locations: [],
  lostModeSettings: {},
  notifications: [],
  unreadCount: 0,

  // Auth actions
  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const user = await authApi.login(email, password) as User;
      set({ user, isLoading: false });
      await get().fetchDevices();
      await get().fetchUnreadCount();
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  register: async (email, password, name) => {
    set({ isLoading: true, error: null });
    try {
      const user = await authApi.register(email, password, name) as User;
      set({ user, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
      throw error;
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } finally {
      set({
        user: null,
        devices: [],
        selectedDevice: null,
        locations: [],
        lostModeSettings: {},
        notifications: [],
        unreadCount: 0,
      });
    }
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const user = await authApi.me() as User;
      set({ user, isLoading: false });
      await get().fetchDevices();
      await get().fetchUnreadCount();
    } catch {
      set({ user: null, isLoading: false });
    }
  },

  // Device actions
  fetchDevices: async () => {
    try {
      const devices = await devicesApi.getAll() as Device[];
      set({ devices });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  createDevice: async (data) => {
    const device = await devicesApi.create(data) as Device;
    set((state) => ({ devices: [device, ...state.devices] }));
    return device;
  },

  updateDevice: async (id, data) => {
    const device = await devicesApi.update(id, data) as Device;
    set((state) => ({
      devices: state.devices.map((d) => (d.id === id ? device : d)),
      selectedDevice: state.selectedDevice?.id === id ? device : state.selectedDevice,
    }));
  },

  deleteDevice: async (id) => {
    await devicesApi.delete(id);
    set((state) => ({
      devices: state.devices.filter((d) => d.id !== id),
      selectedDevice: state.selectedDevice?.id === id ? null : state.selectedDevice,
    }));
  },

  selectDevice: (device) => {
    set({ selectedDevice: device, locations: [] });
    if (device) {
      get().fetchLocations(device.id);
      get().fetchLostMode(device.id);
    }
  },

  playSound: async (id) => {
    await devicesApi.playSound(id);
  },

  // Location actions
  fetchLocations: async (deviceId) => {
    try {
      const locations = await locationsApi.getHistory(deviceId) as Location[];
      set({ locations });
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  simulateLocation: async (deviceId, location) => {
    await locationsApi.simulate(deviceId, location);
    await get().fetchLocations(deviceId);
  },

  // Lost Mode actions
  fetchLostMode: async (deviceId) => {
    try {
      const lostMode = await lostModeApi.get(deviceId) as LostMode;
      set((state) => ({
        lostModeSettings: { ...state.lostModeSettings, [deviceId]: lostMode },
      }));
    } catch (error) {
      console.error('Failed to fetch lost mode:', error);
    }
  },

  updateLostMode: async (deviceId, data) => {
    const lostMode = await lostModeApi.update(deviceId, data) as LostMode;
    set((state) => ({
      lostModeSettings: { ...state.lostModeSettings, [deviceId]: lostMode },
    }));
  },

  enableLostMode: async (deviceId) => {
    const lostMode = await lostModeApi.enable(deviceId) as LostMode;
    set((state) => ({
      lostModeSettings: { ...state.lostModeSettings, [deviceId]: lostMode },
    }));
  },

  disableLostMode: async (deviceId) => {
    const lostMode = await lostModeApi.disable(deviceId) as LostMode;
    set((state) => ({
      lostModeSettings: { ...state.lostModeSettings, [deviceId]: lostMode },
    }));
  },

  // Notification actions
  fetchNotifications: async () => {
    try {
      const notifications = await notificationsApi.getAll() as Notification[];
      set({ notifications });
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
    }
  },

  fetchUnreadCount: async () => {
    try {
      const { count } = await notificationsApi.getUnreadCount() as { count: number };
      set({ unreadCount: count });
    } catch (error) {
      console.error('Failed to fetch unread count:', error);
    }
  },

  markAsRead: async (id) => {
    await notificationsApi.markAsRead(id);
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, is_read: true } : n
      ),
      unreadCount: Math.max(0, state.unreadCount - 1),
    }));
  },

  markAllAsRead: async () => {
    await notificationsApi.markAllAsRead();
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, is_read: true })),
      unreadCount: 0,
    }));
  },

  // UI actions
  clearError: () => set({ error: null }),
}));
