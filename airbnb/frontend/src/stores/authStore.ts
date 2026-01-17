import { create } from 'zustand';
import { User } from '../types';
import { authAPI } from '../services/api';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  becomeHost: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  login: async (email: string, password: string) => {
    const response = await authAPI.login({ email, password }) as { user: User };
    set({ user: response.user, isAuthenticated: true });
  },

  register: async (email: string, password: string, name: string) => {
    const response = await authAPI.register({ email, password, name }) as { user: User };
    set({ user: response.user, isAuthenticated: true });
  },

  logout: async () => {
    await authAPI.logout();
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    try {
      const response = await authAPI.getMe();
      set({ user: response.user, isAuthenticated: true, isLoading: false });
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  becomeHost: async () => {
    await authAPI.becomeHost();
    const { user } = get();
    if (user) {
      set({ user: { ...user, is_host: true } });
    }
  },
}));
