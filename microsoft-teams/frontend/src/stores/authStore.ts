import { create } from 'zustand';
import type { User } from '../types';
import { authApi } from '../services/api';
import { useChatStore } from './chatStore';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  clearError: () => void;
}

/** Authentication state with session-based login, register, logout, and auth check. */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  loading: true,
  error: null,

  login: async (username, password) => {
    set({ loading: true, error: null });
    try {
      const { user } = await authApi.login(username, password);
      set({ user, loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      set({ error: message, loading: false });
      throw err;
    }
  },

  register: async (username, email, password) => {
    set({ loading: true, error: null });
    try {
      const { user } = await authApi.register(username, email, password);
      set({ user, loading: false });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Registration failed';
      set({ error: message, loading: false });
      throw err;
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // ignore
    }
    // Drop the previous user's orgs, messages and open stream; otherwise the
    // next person to sign in on this tab is routed into the old user's org.
    useChatStore.getState().reset();
    set({ user: null, loading: false });
  },

  checkAuth: async () => {
    set({ loading: true });
    try {
      const { user } = await authApi.me();
      set({ user, loading: false });
    } catch {
      set({ user: null, loading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
