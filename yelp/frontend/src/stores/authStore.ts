import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import api from '../services/api';
import type { User } from '../types';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isLoading: true,
      isAuthenticated: false,

      login: async (email: string, password: string) => {
        const response = await api.post<{ user: User; token: string }>('/auth/login', {
          email,
          password,
        });
        set({ user: response.user, isAuthenticated: true });
      },

      register: async (email: string, password: string, name: string) => {
        const response = await api.post<{ user: User; token: string }>('/auth/register', {
          email,
          password,
          name,
        });
        set({ user: response.user, isAuthenticated: true });
      },

      logout: async () => {
        try {
          await api.post('/auth/logout');
        } catch {
          // Ignore logout errors
        }
        set({ user: null, isAuthenticated: false });
      },

      checkAuth: async () => {
        try {
          const response = await api.get<{ user: User }>('/auth/me');
          set({ user: response.user, isAuthenticated: true, isLoading: false });
        } catch {
          set({ user: null, isAuthenticated: false, isLoading: false });
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
    }
  )
);
