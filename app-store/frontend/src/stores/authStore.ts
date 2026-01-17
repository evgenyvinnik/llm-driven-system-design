/**
 * @fileoverview Authentication state management using Zustand.
 * Handles user login, registration, logout, and session persistence.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';
import api from '../services/api';

/**
 * Authentication store state and actions.
 */
interface AuthState {
  /** Currently authenticated user, null if not logged in */
  user: User | null;
  /** Session ID stored in localStorage for API authentication */
  sessionId: string | null;
  /** True when an auth operation is in progress */
  isLoading: boolean;
  /** Error message from the last failed operation */
  error: string | null;
  /** Authenticates user with email and password */
  login: (email: string, password: string) => Promise<void>;
  /** Creates a new user account */
  register: (email: string, password: string, username: string, displayName?: string) => Promise<void>;
  /** Logs out the current user and clears session */
  logout: () => Promise<void>;
  /** Fetches current user data from the server */
  fetchUser: () => Promise<void>;
  /** Clears any stored error message */
  clearError: () => void;
}

/**
 * Zustand store for authentication state.
 * Persists session ID to localStorage for session continuity.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      sessionId: null,
      isLoading: false,
      error: null,

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await api.post<{ data: { user: User; sessionId: string } }>('/auth/login', {
            email,
            password,
          });
          localStorage.setItem('sessionId', response.data.sessionId);
          set({ user: response.data.user, sessionId: response.data.sessionId, isLoading: false });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Login failed', isLoading: false });
          throw error;
        }
      },

      register: async (email: string, password: string, username: string, displayName?: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await api.post<{ data: { user: User; sessionId: string } }>('/auth/register', {
            email,
            password,
            username,
            displayName,
          });
          localStorage.setItem('sessionId', response.data.sessionId);
          set({ user: response.data.user, sessionId: response.data.sessionId, isLoading: false });
        } catch (error) {
          set({ error: error instanceof Error ? error.message : 'Registration failed', isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await api.post('/auth/logout');
        } catch {
          // Ignore errors
        }
        localStorage.removeItem('sessionId');
        set({ user: null, sessionId: null });
      },

      fetchUser: async () => {
        const { sessionId } = get();
        if (!sessionId) return;

        set({ isLoading: true });
        try {
          const response = await api.get<{ data: User }>('/auth/me');
          set({ user: response.data, isLoading: false });
        } catch {
          localStorage.removeItem('sessionId');
          set({ user: null, sessionId: null, isLoading: false });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ sessionId: state.sessionId }),
    }
  )
);
