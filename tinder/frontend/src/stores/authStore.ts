import { create } from 'zustand';
import type { User } from '../types';
import { authApi, userApi } from '../services/api';
import { wsService } from '../services/websocket';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  register: (data: {
    email: string;
    password: string;
    name: string;
    birthdate: string;
    gender: string;
    bio?: string;
  }) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  updateProfile: (data: Partial<User>) => Promise<void>;
  updateLocation: (latitude: number, longitude: number) => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      await authApi.login(email, password);
      const user = await authApi.getMe();
      set({ user, isAuthenticated: true, isLoading: false });
      wsService.connect(user.id);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Login failed',
        isLoading: false,
      });
      throw error;
    }
  },

  register: async (data) => {
    set({ isLoading: true, error: null });
    try {
      await authApi.register(data);
      const user = await authApi.getMe();
      set({ user, isAuthenticated: true, isLoading: false });
      wsService.connect(user.id);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Registration failed',
        isLoading: false,
      });
      throw error;
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } finally {
      wsService.disconnect();
      set({ user: null, isAuthenticated: false });
    }
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const user = await authApi.getMe();
      set({ user, isAuthenticated: true, isLoading: false });
      wsService.connect(user.id);
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  updateProfile: async (data) => {
    try {
      const updatedUser = await userApi.updateProfile(data);
      set({ user: { ...get().user!, ...updatedUser } });
    } catch (error) {
      throw error;
    }
  },

  updateLocation: async (latitude, longitude) => {
    try {
      await userApi.updateLocation(latitude, longitude);
      const user = get().user;
      if (user) {
        set({ user: { ...user, latitude, longitude } });
      }
    } catch (error) {
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
