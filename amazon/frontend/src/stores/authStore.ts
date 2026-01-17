import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '../types';
import { api } from '../services/api';

interface AuthState {
  user: User | null;
  sessionId: string | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      sessionId: null,
      isLoading: false,

      login: async (email: string, password: string) => {
        set({ isLoading: true });
        try {
          const { user, sessionId } = await api.login(email, password);
          localStorage.setItem('sessionId', sessionId);
          set({ user, sessionId, isLoading: false });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      register: async (email: string, password: string, name: string) => {
        set({ isLoading: true });
        try {
          const { user, sessionId } = await api.register(email, password, name);
          localStorage.setItem('sessionId', sessionId);
          set({ user, sessionId, isLoading: false });
        } catch (error) {
          set({ isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await api.logout();
        } catch {
          // Ignore logout errors
        }
        localStorage.removeItem('sessionId');
        set({ user: null, sessionId: null });
      },

      checkAuth: async () => {
        const sessionId = localStorage.getItem('sessionId');
        if (!sessionId) {
          set({ user: null, sessionId: null });
          return;
        }

        try {
          const { user } = await api.getMe();
          set({ user, sessionId });
        } catch {
          localStorage.removeItem('sessionId');
          set({ user: null, sessionId: null });
        }
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ sessionId: state.sessionId }),
    }
  )
);
