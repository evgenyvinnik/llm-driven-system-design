import { create } from 'zustand';
import type { User, AuthState } from '../types';
import { api } from '../services/api';
import { wsService } from '../services/websocket';

interface AuthStore extends AuthState {
  login: (email: string, password: string, deviceName?: string) => Promise<void>;
  register: (email: string, password: string, deviceName?: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  deviceId: null,
  token: null,
  isLoading: true,
  error: null,

  login: async (email, password, deviceName) => {
    set({ isLoading: true, error: null });
    try {
      const result = await api.login(email, password, deviceName || `Web Browser ${new Date().toLocaleDateString()}`);
      set({
        user: result.user as User,
        deviceId: result.deviceId,
        token: result.token,
        isLoading: false,
      });
      // Connect WebSocket
      wsService.connect(result.token);
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Login failed',
      });
      throw error;
    }
  },

  register: async (email, password, deviceName) => {
    set({ isLoading: true, error: null });
    try {
      const result = await api.register(email, password, deviceName || `Web Browser ${new Date().toLocaleDateString()}`);
      set({
        user: result.user as User,
        deviceId: result.deviceId,
        token: result.token,
        isLoading: false,
      });
      // Connect WebSocket
      wsService.connect(result.token);
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Registration failed',
      });
      throw error;
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      wsService.disconnect();
      set({ user: null, deviceId: null, token: null, isLoading: false });
    }
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const result = await api.getCurrentUser();
      set({
        user: result.user as User,
        deviceId: result.deviceId,
        isLoading: false,
      });
      // Get token from cookie and connect WebSocket
      // Note: Token is in httpOnly cookie, so we use a different approach
      // WebSocket will use the same session
    } catch (error) {
      set({ user: null, deviceId: null, token: null, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
