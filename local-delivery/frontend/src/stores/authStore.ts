/**
 * Authentication state management for the delivery platform.
 * Manages user session, login/logout, and token persistence.
 * Uses Zustand with localStorage persistence for session continuity.
 *
 * @module stores/authStore
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { api } from '@/services/api';
import type { User } from '@/types';

/**
 * Authentication store state and actions.
 */
interface AuthState {
  /** Currently authenticated user, null if not logged in */
  user: User | null;
  /** Session token, null if not logged in */
  token: string | null;
  /** True during authentication operations */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;

  /**
   * Authenticates user with email and password.
   *
   * @param email - User's email
   * @param password - User's password
   */
  login: (email: string, password: string) => Promise<void>;

  /**
   * Creates a new user account.
   *
   * @param email - New user's email
   * @param password - New user's password
   * @param name - New user's display name
   * @param role - User role (customer, driver, merchant)
   * @param phone - Optional phone number
   * @param vehicleType - Required for driver registration
   * @param licensePlate - Optional license plate for drivers
   */
  register: (
    email: string,
    password: string,
    name: string,
    role: string,
    phone?: string,
    vehicleType?: string,
    licensePlate?: string
  ) => Promise<void>;

  /**
   * Logs out the current user and clears session.
   */
  logout: () => Promise<void>;

  /**
   * Loads user data from stored token on app initialization.
   */
  loadUser: () => Promise<void>;

  /**
   * Clears any authentication error message.
   */
  clearError: () => void;
}

/**
 * Zustand store for authentication state.
 * Token is persisted to localStorage for session continuity across page reloads.
 */
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
