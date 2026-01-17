/**
 * Authentication Store.
 *
 * Manages admin user authentication state using Zustand with persistence.
 * Handles login, logout, and session validation for the admin dashboard.
 *
 * @module stores/authStore
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { adminApi } from '../services/api';

/**
 * Authenticated user information.
 */
interface User {
  /** User UUID */
  id: string;
  /** Login username */
  username: string;
  /** User role (e.g., "admin", "viewer") */
  role: string;
}

/**
 * Authentication store state and actions.
 */
interface AuthState {
  /** Currently authenticated user or null */
  user: User | null;
  /** Session token or null */
  token: string | null;
  /** Whether a valid session exists */
  isAuthenticated: boolean;
  /** Whether an auth operation is in progress */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;
  /**
   * Authenticate with username and password.
   * @param username - Admin username
   * @param password - Admin password
   */
  login: (username: string, password: string) => Promise<void>;
  /** End the current session and clear credentials. */
  logout: () => Promise<void>;
  /** Validate the stored token and refresh user info. */
  checkAuth: () => Promise<void>;
  /** Clear the error message. */
  clearError: () => void;
}

/**
 * Zustand store for authentication state.
 * Uses localStorage persistence for the token.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      login: async (username: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await adminApi.login(username, password);
          localStorage.setItem('auth_token', response.token);
          set({
            user: response.user,
            token: response.token,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Login failed',
            isLoading: false,
          });
          throw error;
        }
      },

      logout: async () => {
        try {
          await adminApi.logout();
        } catch {
          // Ignore logout errors
        } finally {
          localStorage.removeItem('auth_token');
          set({
            user: null,
            token: null,
            isAuthenticated: false,
          });
        }
      },

      checkAuth: async () => {
        const token = localStorage.getItem('auth_token');
        if (!token) {
          set({ isAuthenticated: false, user: null, token: null });
          return;
        }

        set({ isLoading: true });
        try {
          const user = await adminApi.getMe();
          set({
            user,
            token,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch {
          localStorage.removeItem('auth_token');
          set({
            user: null,
            token: null,
            isAuthenticated: false,
            isLoading: false,
          });
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
