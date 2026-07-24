/**
 * Authentication state management store.
 * Handles user login, registration, logout, and session persistence.
 * Uses Zustand with persist middleware to store token in localStorage.
 * @module stores/authStore
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../types';
import { authApi } from '../services/api';

/**
 * Authentication state interface.
 * Contains user data, loading/error state, and authentication actions.
 */
interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  /** True once the initial checkAuth() has completed (success or failure). */
  authChecked: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

/**
 * Zustand store for authentication state.
 * Persists only the token to localStorage for session restoration.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isLoading: false,
      // False until checkAuth() has finished its first run. The route guard must
      // wait for this before deciding the user is logged out — otherwise the
      // first render (user still null) redirects to /login before the
      // session-restore /auth/me call resolves, bouncing a valid cookie session.
      // Kept separate from isLoading so the login button (disabled={isLoading})
      // isn't disabled during the initial check.
      authChecked: false,
      error: null,

      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const { user, token } = await authApi.login(email, password);
          set({ user, token, isLoading: false });
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      register: async (email, password, name) => {
        set({ isLoading: true, error: null });
        try {
          const { user, token } = await authApi.register(email, password, name);
          set({ user, token, isLoading: false });
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await authApi.logout();
        } catch {
          // Ignore logout errors
        }
        set({ user: null, token: null });
      },

      checkAuth: async () => {
        set({ isLoading: true });
        try {
          const { user } = await authApi.getMe();
          set({ user, isLoading: false, authChecked: true });
        } catch {
          set({ user: null, token: null, isLoading: false, authChecked: true });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'dropbox-auth',
      partialize: (state) => ({ token: state.token }),
    }
  )
);
