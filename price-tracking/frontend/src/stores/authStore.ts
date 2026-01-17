/**
 * Zustand store for authentication state management.
 * Handles login, registration, logout, and session persistence.
 * @module stores/authStore
 */
import { create } from 'zustand';
import { User } from '../types';
import * as authService from '../services/auth';

/**
 * Authentication state shape.
 */
interface AuthState {
  /** Currently authenticated user or null */
  user: User | null;
  /** True while checking initial auth state */
  isLoading: boolean;
  /** True if user is authenticated */
  isAuthenticated: boolean;
  /** Logs in with email and password */
  login: (email: string, password: string) => Promise<void>;
  /** Registers a new account */
  register: (email: string, password: string) => Promise<void>;
  /** Logs out the current user */
  logout: () => Promise<void>;
  /** Checks if there's a valid session on app load */
  checkAuth: () => Promise<void>;
  /** Updates user settings */
  updateSettings: (settings: { email_notifications?: boolean }) => Promise<void>;
}

/**
 * Global authentication store.
 * Use with: const { user, isAuthenticated, login } = useAuthStore();
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  login: async (email: string, password: string) => {
    const { user } = await authService.login(email, password);
    set({ user, isAuthenticated: true });
  },

  register: async (email: string, password: string) => {
    const { user } = await authService.register(email, password);
    set({ user, isAuthenticated: true });
  },

  logout: async () => {
    await authService.logout();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    try {
      const token = localStorage.getItem('token');
      if (!token) {
        set({ isLoading: false, isAuthenticated: false });
        return;
      }
      const user = await authService.getCurrentUser();
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      localStorage.removeItem('token');
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  updateSettings: async (settings: { email_notifications?: boolean }) => {
    const user = await authService.updateUserSettings(settings);
    set({ user });
  },
}));
