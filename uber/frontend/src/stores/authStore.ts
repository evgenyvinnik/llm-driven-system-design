import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../types';
import api from '../services/api';
import wsService from '../services/websocket';

interface AuthState {
  user: User | null;
  token: string | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  registerRider: (email: string, password: string, name: string, phone?: string) => Promise<void>;
  registerDriver: (
    email: string,
    password: string,
    name: string,
    phone: string,
    vehicle: {
      vehicleType: string;
      vehicleMake: string;
      vehicleModel: string;
      vehicleColor: string;
      licensePlate: string;
    }
  ) => Promise<void>;
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
          const result = await api.auth.login(email, password);
          const user = result.user as User;
          const token = result.token;

          localStorage.setItem('token', token);
          set({ user, token, isLoading: false });

          // Connect WebSocket
          wsService.connect(token).catch(console.error);
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      registerRider: async (email: string, password: string, name: string, phone?: string) => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.auth.registerRider({ email, password, name, phone });
          const user = result.user as User;
          const token = result.token;

          localStorage.setItem('token', token);
          set({ user, token, isLoading: false });

          wsService.connect(token).catch(console.error);
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      registerDriver: async (email, password, name, phone, vehicle) => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.auth.registerDriver({ email, password, name, phone, vehicle });
          const user = result.user as User;
          const token = result.token;

          localStorage.setItem('token', token);
          set({ user, token, isLoading: false });

          wsService.connect(token).catch(console.error);
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await api.auth.logout();
        } catch {
          // Ignore errors during logout
        }

        localStorage.removeItem('token');
        wsService.disconnect();
        set({ user: null, token: null });
      },

      checkAuth: async () => {
        const token = localStorage.getItem('token');
        if (!token) {
          set({ user: null, token: null });
          return;
        }

        try {
          const result = await api.auth.me();
          const user = result.user as User;
          set({ user, token });

          wsService.connect(token).catch(console.error);
        } catch {
          localStorage.removeItem('token');
          set({ user: null, token: null });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'uber-auth',
      partialize: (state) => ({ token: state.token }),
    }
  )
);
