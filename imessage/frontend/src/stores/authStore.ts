import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User } from '@/types';
import { api } from '@/services/api';
import { wsService } from '@/services/websocket';
import { getInstallId } from '@/lib/ids';

/**
 * Authentication state interface.
 * Tracks the current user, their device, authentication token, and loading state.
 */
interface AuthState {
  /** Currently authenticated user, or null if not logged in */
  user: User | null;
  /** Current device identifier for multi-device support */
  deviceId: string | null;
  /** JWT authentication token */
  token: string | null;
  /** Whether the user is currently authenticated */
  isAuthenticated: boolean;
  /** Whether authentication check is in progress */
  isLoading: boolean;

  // Actions
  /**
   * Authenticates user with credentials.
   * @param usernameOrEmail - Username or email address
   * @param password - User's password
   */
  login: (usernameOrEmail: string, password: string) => Promise<void>;
  /**
   * Creates a new user account.
   * @param username - Unique username
   * @param email - Email address
   * @param password - Password (min 6 characters)
   * @param displayName - Optional display name
   */
  register: (username: string, email: string, password: string, displayName?: string) => Promise<void>;
  /** Logs out the current user and cleans up session */
  logout: () => Promise<void>;
  /** Validates existing token and restores session on app load */
  checkAuth: () => Promise<void>;
  /**
   * Updates the current user in state (for profile updates).
   * @param user - Updated user object
   */
  setUser: (user: User) => void;
}

/**
 * Zustand store for authentication state management.
 * Persists the JWT token to localStorage for session restoration.
 * Automatically connects WebSocket on successful authentication.
 *
 * This store is the source of truth for user authentication state
 * throughout the application.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
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
          installId: getInstallId(),
        }) as { user: User; device: { id: string }; token: string };

        localStorage.setItem('token', response.token);

        set({
          user: response.user,
          deviceId: response.device.id,
          token: response.token,
          isAuthenticated: true,
          isLoading: false,
        });

        // Connect WebSocket; the server pushes this device's undelivered messages on connect
        wsService.connect(response.token);
      },

      register: async (username: string, email: string, password: string, displayName?: string) => {
        const response = await api.register({
          username,
          email,
          password,
          displayName,
          deviceName: navigator.userAgent.slice(0, 50),
          installId: getInstallId(),
        }) as { user: User; device: { id: string }; token: string };

        localStorage.setItem('token', response.token);

        set({
          user: response.user,
          deviceId: response.device.id,
          token: response.token,
          isAuthenticated: true,
          isLoading: false,
        });

        // Connect WebSocket; the server pushes this device's undelivered messages on connect
        wsService.connect(response.token);
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
          wsService.connect(token);
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
