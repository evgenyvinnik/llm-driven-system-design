import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';
import { authApi } from '../services/api';
import wsService from '../services/websocket';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<boolean>;
  register: (email: string, name: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

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
