import { create } from 'zustand';
import { authApi } from '../services/api';

interface User {
  id: string;
  username: string;
  role: 'user' | 'admin';
}

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  login: async (username: string, password: string) => {
    const response = await authApi.login(username, password);
    set({
      user: response.user as User,
      isAuthenticated: true,
    });
  },

  register: async (username: string, email: string, password: string) => {
    const response = await authApi.register(username, email, password);
    set({
      user: response.user as User,
      isAuthenticated: true,
    });
  },

  logout: async () => {
    await authApi.logout();
    set({
      user: null,
      isAuthenticated: false,
    });
  },

  checkAuth: async () => {
    try {
      const response = await authApi.me();
      set({
        user: response.user as User,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch {
      set({
        user: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },
}));
