/**
 * Authentication state management using Zustand.
 * Provides login, registration, and logout functionality.
 * State is persisted to localStorage for session persistence across refreshes.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';
import { authApi } from '../services/api';

/**
 * Authentication store state and actions.
 */
interface AuthState {
  /** Currently authenticated user, or null if not logged in */
  user: User | null;
  /** Session token for API authentication */
  token: string | null;
  /** Whether user is currently authenticated */
  isAuthenticated: boolean;
  /** Whether an auth operation is in progress */
  isLoading: boolean;
  /** Error message from last failed auth operation */
  error: string | null;
  /** Logs in with email and password */
  login: (email: string, password: string) => Promise<void>;
  /** Registers a new user account */
  register: (data: { email: string; password: string; firstName?: string; lastName?: string }) => Promise<void>;
  /** Logs out the current user */
  logout: () => Promise<void>;
  /** Clears any stored error message */
  clearError: () => void;
}

/**
 * Zustand store for authentication state.
 * Persists user, token, and isAuthenticated to localStorage.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      token: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.login(email, password);
          localStorage.setItem('token', response.token);
          set({
            user: response.user,
            token: response.token,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({
            error: (error as Error).message,
            isLoading: false,
          });
          throw error;
        }
      },

      register: async (data) => {
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.register(data);
          localStorage.setItem('token', response.token);
          set({
            user: response.user,
            token: response.token,
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error) {
          set({
            error: (error as Error).message,
            isLoading: false,
          });
          throw error;
        }
      },

      logout: async () => {
        try {
          await authApi.logout();
        } catch {
          // Ignore logout errors
        }
        localStorage.removeItem('token');
        set({
          user: null,
          token: null,
          isAuthenticated: false,
        });
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        user: state.user,
        token: state.token,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);
