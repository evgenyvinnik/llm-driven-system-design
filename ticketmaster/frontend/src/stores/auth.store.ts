/**
 * Authentication store using Zustand for state management.
 * Manages user authentication state, login/logout flows, and session persistence.
 */
import { create } from 'zustand';
import type { User } from '../types';
import { authApi } from '../services/api';

/**
 * Shape of the authentication store state and actions.
 */
interface AuthState {
  /** Currently authenticated user, or null if not logged in */
  user: User | null;
  /** Whether authentication is currently being checked or processed */
  isLoading: boolean;
  /** Whether user is authenticated */
  isAuthenticated: boolean;
  /** Current error message, if any */
  error: string | null;

  /**
   * Logs in a user with email and password.
   * Stores session ID in localStorage on success.
   */
  login: (email: string, password: string) => Promise<void>;

  /**
   * Registers a new user account.
   * Automatically logs in the user on success.
   */
  register: (email: string, password: string, name: string) => Promise<void>;

  /**
   * Logs out the current user.
   * Clears session from localStorage and server.
   */
  logout: () => Promise<void>;

  /**
   * Checks if there's an existing valid session.
   * Called on app startup to restore authentication state.
   */
  checkAuth: () => Promise<void>;

  /** Clears any authentication error */
  clearError: () => void;
}

/**
 * Zustand store for authentication state.
 * Persists session ID in localStorage for session continuity across page loads.
 */
export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  error: null,

  login: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await authApi.login(email, password);
      if (response.data) {
        set({ user: response.data.user, isAuthenticated: true, isLoading: false });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Login failed', isLoading: false });
      throw error;
    }
  },

  register: async (email: string, password: string, name: string) => {
    set({ isLoading: true, error: null });
    try {
      await authApi.register(email, password, name);
      // Auto-login after registration
      const loginResponse = await authApi.login(email, password);
      if (loginResponse.data) {
        set({ user: loginResponse.data.user, isAuthenticated: true, isLoading: false });
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Registration failed', isLoading: false });
      throw error;
    }
  },

  logout: async () => {
    try {
      await authApi.logout();
    } catch {
      // Ignore logout errors
    }
    set({ user: null, isAuthenticated: false });
  },

  checkAuth: async () => {
    const sessionId = localStorage.getItem('sessionId');
    if (!sessionId) {
      set({ isLoading: false, isAuthenticated: false });
      return;
    }

    try {
      const response = await authApi.me();
      if (response.data) {
        set({ user: response.data, isAuthenticated: true, isLoading: false });
      } else {
        set({ isLoading: false, isAuthenticated: false });
      }
    } catch {
      localStorage.removeItem('sessionId');
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
