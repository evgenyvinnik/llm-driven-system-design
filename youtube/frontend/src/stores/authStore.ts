import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User, AuthResponse, LoginCredentials, RegisterData } from '../types';
import { api } from '../services/api';

/**
 * Authentication state interface for the auth store.
 * Defines the shape of auth-related state and actions available to components.
 */
interface AuthState {
  /** Currently authenticated user, or null if not logged in */
  user: User | null;
  /** Whether an auth operation is in progress */
  isLoading: boolean;
  /** Error message from the last failed auth operation */
  error: string | null;

  /** Authenticate user with username and password */
  login: (credentials: LoginCredentials) => Promise<void>;
  /** Create a new user account and authenticate */
  register: (data: RegisterData) => Promise<void>;
  /** Sign out the current user and clear session */
  logout: () => Promise<void>;
  /** Verify current session and refresh user data */
  checkAuth: () => Promise<void>;
  /** Clear any existing error message */
  clearError: () => void;
}

/**
 * Global authentication store for managing user sessions.
 * Uses Zustand with persistence to localStorage, ensuring the user
 * remains logged in across page refreshes. Handles login, registration,
 * logout, and session verification against the backend.
 */
/** Authentication state with login, register, logout, and channel management. */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isLoading: false,
      error: null,

      login: async (credentials) => {
        set({ isLoading: true, error: null });
        try {
          const response = await api.post<AuthResponse>('/auth/login', credentials);
          set({ user: response.user, isLoading: false });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Login failed',
            isLoading: false,
          });
          throw error;
        }
      },

      register: async (data) => {
        set({ isLoading: true, error: null });
        try {
          const response = await api.post<AuthResponse>('/auth/register', data);
          set({ user: response.user, isLoading: false });
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Registration failed',
            isLoading: false,
          });
          throw error;
        }
      },

      logout: async () => {
        try {
          await api.post('/auth/logout');
        } finally {
          set({ user: null });
        }
      },

      checkAuth: async () => {
        // Snapshot the user before the request. `checkAuth` runs on mount, and a
        // login can complete while its /auth/me is still in flight — if the
        // in-flight probe then 401s (it was sent before the session cookie
        // existed) and unconditionally clears state, it silently logs the user
        // back out a moment after a successful sign-in. Only clear if nobody
        // signed in while we were waiting.
        const userBefore = get().user;
        set({ isLoading: true });
        try {
          const response = await api.get<{ user: User }>('/auth/me');
          set({ user: response.user, isLoading: false });
        } catch {
          if (get().user === userBefore) {
            set({ user: null, isLoading: false });
          } else {
            set({ isLoading: false });
          }
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'youtube-auth',
      partialize: (state) => ({ user: state.user }),
    }
  )
);
