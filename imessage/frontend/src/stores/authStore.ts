import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@/types';
import { api } from '@/services/api';
import { wsService } from '@/services/websocket';

interface AuthState {
  user: User | null;
  deviceId: string | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;

  // Actions
  login: (usernameOrEmail: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  setUser: (user: User) => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      deviceId: null,
      token: null,
      isAuthenticated: false,
      isLoading: true,

      login: async (usernameOrEmail: string, password: string) => {
        const response = await api.login({
          usernameOrEmail,
          password,
          deviceName: navigator.userAgent.slice(0, 50),
        }) as { user: User; device: { id: string }; token: string };

        localStorage.setItem('token', response.token);

        set({
          user: response.user,
          deviceId: response.device.id,
          token: response.token,
          isAuthenticated: true,
          isLoading: false,
        });

        // Connect WebSocket
        await wsService.connect(response.token);
      },

      register: async (username: string, email: string, password: string, displayName?: string) => {
        const response = await api.register({
          username,
          email,
          password,
          displayName,
          deviceName: navigator.userAgent.slice(0, 50),
        }) as { user: User; device: { id: string }; token: string };

        localStorage.setItem('token', response.token);

        set({
          user: response.user,
          deviceId: response.device.id,
          token: response.token,
          isAuthenticated: true,
          isLoading: false,
        });

        // Connect WebSocket
        await wsService.connect(response.token);
      },

      logout: async () => {
        try {
          await api.logout();
        } catch (error) {
          console.error('Logout error:', error);
        }

        localStorage.removeItem('token');
        wsService.disconnect();

        set({
          user: null,
          deviceId: null,
          token: null,
          isAuthenticated: false,
          isLoading: false,
        });
      },

      checkAuth: async () => {
        const token = localStorage.getItem('token');

        if (!token) {
          set({ isLoading: false, isAuthenticated: false });
          return;
        }

        try {
          const response = await api.getMe();

          set({
            user: response.user,
            deviceId: response.deviceId,
            token,
            isAuthenticated: true,
            isLoading: false,
          });

          // Connect WebSocket
          await wsService.connect(token);
        } catch (error) {
          console.error('Auth check failed:', error);
          localStorage.removeItem('token');
          set({
            user: null,
            deviceId: null,
            token: null,
            isAuthenticated: false,
            isLoading: false,
          });
        }
      },

      setUser: (user: User) => {
        set({ user });
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({
        token: state.token,
      }),
    }
  )
);
