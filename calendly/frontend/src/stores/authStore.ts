import { create } from 'zustand';
import type { User } from '../types';
import { authApi } from '../services/api';

/**
 * Authentication state interface.
 * Manages user authentication status and provides auth actions.
 */
interface AuthState {
  /** Currently authenticated user or null if not logged in */
  user: User | null;
  /** Whether auth check is in progress (for initial load) */
  isLoading: boolean;
  /** Whether a user is currently authenticated */
  isAuthenticated: boolean;
  /** Attempt to log in with email and password */
  login: (email: string, password: string) => Promise<boolean>;
  /** Register a new user account */
  register: (email: string, password: string, name: string, timezone: string) => Promise<boolean>;
  /** Log out the current user */
  logout: () => Promise<void>;
  /** Check if user has an active session */
  checkAuth: () => Promise<void>;
}

/**
 * Zustand store for authentication state management.
 * Provides reactive access to user data and auth actions.
 * Used throughout the app for auth-dependent UI rendering.
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  login: async (email, password) => {
    const response = await authApi.login(email, password);
    if (response.success && response.data) {
      set({ user: response.data, isAuthenticated: true });
      return true;
    }
    return false;
  },

  register: async (email, password, name, timezone) => {
    const response = await authApi.register(email, password, name, timezone);
    if (response.success && response.data) {
      set({ user: response.data, isAuthenticated: true });
      return true;
    }
    return false;
  },

  logout: async () => {
    await authApi.logout();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const response = await authApi.me();
      if (response.success && response.data) {
        set({ user: response.data, isAuthenticated: true, isLoading: false });
      } else {
        set({ user: null, isAuthenticated: false, isLoading: false });
      }
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
