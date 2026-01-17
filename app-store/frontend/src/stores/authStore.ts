import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';
import api from '../services/api';

interface AuthState {
  user: User | null;
  sessionId: string | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, username: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
  fetchUser: () => Promise<void>;
  clearError: () => void;
}

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
