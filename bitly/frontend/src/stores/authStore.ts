/**
 * Authentication Store
 *
 * Manages user authentication state using Zustand with localStorage persistence.
 * Provides login, logout, registration, and session verification functionality.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../types';
import { api } from '../services/api';
import { useUrlStore } from './urlStore';

/**
 * Authentication state interface.
 * Includes user data, loading state, and authentication actions.
 */
interface AuthState {
  user: User | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<boolean>;
  register: (email: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

/**
 * Authentication store hook.
 * Persists user data to localStorage for session continuity across page reloads.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isLoading: false,
      error: null,

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const { user } = await api.auth.login(email, password);
          // Never show links cached for a previous account in this tab.
          useUrlStore.getState().reset();
          set({ user, isLoading: false });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Login failed';
          set({ error: message, isLoading: false });
          return false;
        }
      },

      register: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          await api.auth.register(email, password);
          set({ isLoading: false });
          return true;
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Registration failed';
          set({ error: message, isLoading: false });
          return false;
        }
      },

      logout: async () => {
        set({ isLoading: true });
        // Clear per-user data first; this also discards responses still in flight.
        useUrlStore.getState().reset();
        try {
          await api.auth.logout();
        } catch {
          // Ignore logout errors (the server clears the cookie regardless)
        }
        set({ user: null, isLoading: false });
      },

      checkAuth: async () => {
        set({ isLoading: true });
        try {
          const user = await api.auth.me();
          set({ user, isLoading: false });
        } catch {
          useUrlStore.getState().reset();
          set({ user: null, isLoading: false });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user }),
    }
  )
);
