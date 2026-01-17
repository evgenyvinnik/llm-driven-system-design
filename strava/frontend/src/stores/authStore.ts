import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../types';
import { auth } from '../services/api';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
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
        const response = await auth.login(email, password);
        set({ user: response.user, isAuthenticated: true });
      },

      register: async (username: string, email: string, password: string) => {
        const response = await auth.register({ username, email, password });
        set({ user: response.user, isAuthenticated: true });
      },

      logout: async () => {
        await auth.logout();
        set({ user: null, isAuthenticated: false });
      },

      checkAuth: async () => {
        try {
          const response = await auth.me();
          set({ user: response.user, isAuthenticated: true, isLoading: false });
        } catch {
          set({ user: null, isAuthenticated: false, isLoading: false });
        }
      },
    }),
    {
      name: 'strava-auth',
      partialize: (state) => ({ user: state.user, isAuthenticated: state.isAuthenticated }),
    }
  )
);
