/**
 * Authentication store for managing user session state.
 * Persists token to localStorage and syncs with WebSocket service.
 * Uses Zustand for reactive state management.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';
import { authApi } from '../services/api';
import wsService from '../services/websocket';

/**
 * Authentication state interface for Zustand store.
 * Contains user data, session token, loading state, and auth actions.
 */
interface AuthState {
  /** Currently authenticated user or null */
  user: User | null;
  /** Session token for API and WebSocket authentication */
  token: string | null;
  /** True when auth operation is in progress */
  isLoading: boolean;
  /** Error message from last failed auth operation */
  error: string | null;

  /**
   * Authenticates a user with email and password.
   * @param email - User's email
   * @param password - User's password
   * @returns True if login successful
   */
  login: (email: string, password: string) => Promise<boolean>;

  /**
   * Creates a new user account.
   * @param email - User's email
   * @param name - User's display name
   * @param password - User's password
   * @returns True if registration successful
   */
  register: (email: string, name: string, password: string) => Promise<boolean>;

  /**
   * Logs out the current user and clears session.
   */
  logout: () => Promise<void>;

  /**
   * Validates the current session token with the server.
   * Called on app initialization.
   */
  checkAuth: () => Promise<void>;

  /**
   * Clears any authentication error.
   */
  clearError: () => void;
}

/**
 * Zustand store for authentication state management.
 * Persists token to localStorage for session persistence across page reloads.
 * Automatically syncs authentication token with WebSocket service.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isLoading: false,
      error: null,

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });

        try {
          const response = await authApi.login(email, password);

          if (response.success && response.data) {
            const { user, token } = response.data;
            set({ user, token, isLoading: false });
            wsService.setToken(token);
            return true;
          } else {
            set({ error: response.error || 'Login failed', isLoading: false });
            return false;
          }
        } catch (error) {
          set({ error: 'Network error', isLoading: false });
          return false;
        }
      },

      register: async (email: string, name: string, password: string) => {
        set({ isLoading: true, error: null });

        try {
          const response = await authApi.register(email, name, password);

          if (response.success && response.data) {
            const { user, token } = response.data;
            set({ user, token, isLoading: false });
            wsService.setToken(token);
            return true;
          } else {
            set({ error: response.error || 'Registration failed', isLoading: false });
            return false;
          }
        } catch (error) {
          set({ error: 'Network error', isLoading: false });
          return false;
        }
      },

      logout: async () => {
        try {
          await authApi.logout();
        } catch (error) {
          console.error('Logout error:', error);
        }

        wsService.disconnect();
        wsService.setToken(null);
        set({ user: null, token: null });
      },

      checkAuth: async () => {
        const { token } = get();
        if (!token) return;

        set({ isLoading: true });

        try {
          const response = await authApi.me();

          if (response.success && response.data) {
            set({ user: response.data.user, isLoading: false });
            wsService.setToken(token);
          } else {
            set({ user: null, token: null, isLoading: false });
            wsService.setToken(null);
          }
        } catch (error) {
          set({ user: null, token: null, isLoading: false });
          wsService.setToken(null);
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ token: state.token }),
    }
  )
);
