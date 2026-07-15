import { create } from 'zustand';
import type { User } from '../types';
import { api } from '../services/api';

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (data: { username: string; email: string; password: string; name: string }) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

/** Authentication state: session persistence, login/register/logout, and hydration. */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isAuthenticated: false,
  isLoading: true,

  login: async (username, password) => {
    const { user, sessionId } = await api.login(username, password);
    localStorage.setItem('sessionId', sessionId);
    set({ user, isAuthenticated: true });
  },

  register: async (data) => {
    const { user, sessionId } = await api.register(data);
    localStorage.setItem('sessionId', sessionId);
    set({ user, isAuthenticated: true });
  },

  logout: async () => {
    try {
      await api.logout();
    } catch {
      // ignore network errors on logout
    }
    localStorage.removeItem('sessionId');
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      set({ isLoading: false });
      return;
    }
    try {
      const user = await api.getMe();
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      localStorage.removeItem('sessionId');
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
