/**
 * Authentication state management using Zustand.
 * Handles user login, registration, logout, and session persistence.
 * State is persisted to localStorage for session restoration.
 *
 * @module stores/authStore
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';
import { authApi } from '../services/api';

/**
 * Authentication state interface.
 * Defines the shape of auth state and available actions.
 */
interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (data: { email: string; password: string; firstName: string; lastName: string; headline?: string }) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  updateUser: (user: User) => void;
}

/**
 * Zustand store for authentication state.
 * Provides login, register, logout, and session check actions.
 * Persists user and isAuthenticated to localStorage under 'linkedin-auth' key.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isLoading: true,
      isAuthenticated: false,

      login: async (email: string, password: string) => {
        const { user } = await authApi.login(email, password);
        set({ user, isAuthenticated: true });
      },

      register: async (data) => {
        const { user } = await authApi.register(data);
        set({ user, isAuthenticated: true });
      },

      logout: async () => {
        await authApi.logout();
        set({ user: null, isAuthenticated: false });
      },

      checkAuth: async () => {
        try {
          set({ isLoading: true });
          const { user } = await authApi.me();
          set({ user, isAuthenticated: true, isLoading: false });
        } catch {
          set({ user: null, isAuthenticated: false, isLoading: false });
        }
      },

      updateUser: (user: User) => {
        set({ user });
      },
    }),
    {
      name: 'linkedin-auth',
      partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
    }
  )
);
