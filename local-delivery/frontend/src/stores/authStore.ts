import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '@/services/api';
import type { User } from '@/types';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    name: string,
    role: string,
    phone?: string,
    vehicleType?: string,
    licensePlate?: string
  ) => Promise<void>;
  logout: () => Promise<void>;
  loadUser: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      token: null,
      isLoading: false,
      error: null,

      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const { user, token } = await api.login(email, password);
          localStorage.setItem('token', token);
          set({ user, token, isLoading: false });
        } catch (error) {
          set({
            error: (error as Error).message || 'Login failed',
            isLoading: false,
          });
          throw error;
        }
      },

      register: async (email, password, name, role, phone, vehicleType, licensePlate) => {
        set({ isLoading: true, error: null });
        try {
          const { user, token } = await api.register(
            email,
            password,
            name,
            role,
            phone,
            vehicleType,
            licensePlate
          );
          localStorage.setItem('token', token);
          set({ user, token, isLoading: false });
        } catch (error) {
          set({
            error: (error as Error).message || 'Registration failed',
            isLoading: false,
          });
          throw error;
        }
      },

      logout: async () => {
        try {
          await api.logout();
        } catch {
          // Ignore logout errors
        }
        localStorage.removeItem('token');
        set({ user: null, token: null });
      },

      loadUser: async () => {
        const token = localStorage.getItem('token');
        if (!token) {
          set({ user: null, token: null });
          return;
        }

        set({ isLoading: true });
        try {
          const user = await api.getMe();
          set({ user, token, isLoading: false });
        } catch {
          localStorage.removeItem('token');
          set({ user: null, token: null, isLoading: false });
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
