import { create } from 'zustand';
import type { User } from '../types';
import { authApi, userApi } from '../services/api';
import { wsService } from '../services/websocket';

/**
 * Authentication store state and actions interface.
 * Manages user session, login/register flows, and profile updates.
 */
interface AuthState {
  /** Current authenticated user or null */
  user: User | null;
  /** Whether an auth operation is in progress */
  isLoading: boolean;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Error message from last failed operation */
  error: string | null;

  /** Authenticates user with email/password */
  login: (email: string, password: string) => Promise<void>;
  /** Registers a new user account */
  register: (data: {
    email: string;
    password: string;
    name: string;
    birthdate: string;
    gender: string;
    bio?: string;
  }) => Promise<void>;
  /** Logs out current user and disconnects WebSocket */
  logout: () => Promise<void>;
  /** Checks if user has valid session on app load */
  checkAuth: () => Promise<void>;
  /** Updates user profile fields */
  updateProfile: (data: {
    name?: string;
    bio?: string;
    job_title?: string;
    company?: string;
    school?: string;
  }) => Promise<void>;
  /** Updates user's geographic location */
  updateLocation: (latitude: number, longitude: number) => Promise<void>;
  /** Clears error state */
  clearError: () => void;
}

/**
 * Zustand store for authentication and user session management.
 * Handles login, registration, logout, and session validation.
 * Automatically connects/disconnects WebSocket on auth state changes.
 */
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
