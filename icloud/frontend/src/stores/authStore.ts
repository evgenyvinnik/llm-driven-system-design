import { create } from 'zustand';
import type { User, AuthState } from '../types';
import { api } from '../services/api';
import { wsService } from '../services/websocket';

/**
 * Extended auth store interface with action methods.
 *
 * Combines the authentication state with methods to manage
 * user sessions, including login, registration, and logout.
 */
interface AuthStore extends AuthState {
  /** Authenticates user with email/password and establishes session */
  login: (email: string, password: string, deviceName?: string) => Promise<void>;
  /** Creates new user account and logs in */
  register: (email: string, password: string, deviceName?: string) => Promise<void>;
  /** Terminates session and disconnects WebSocket */
  logout: () => Promise<void>;
  /** Restores session from existing cookie on page load */
  checkAuth: () => Promise<void>;
  /** Clears any displayed error message */
  clearError: () => void;
}

/**
 * Global authentication state store using Zustand.
 *
 * Manages user authentication state across the application. This store is
 * the source of truth for whether a user is logged in, their profile data,
 * and their current device ID. It also manages the WebSocket connection
 * lifecycle, connecting on login and disconnecting on logout.
 *
 * The store persists session state via httpOnly cookies managed by the
 * backend, but maintains client-side state for UI rendering and route guards.
 */
export const useAuthStore = create<AuthStore>((set, _get) => ({
  user: null,
  deviceId: null,
  token: null,
  isLoading: true,
  error: null,

  login: async (email, password, deviceName) => {
    set({ isLoading: true, error: null });
    try {
      const result = await api.login(email, password, deviceName || `Web Browser ${new Date().toLocaleDateString()}`);
      set({
        user: result.user as User,
        deviceId: result.deviceId,
        token: result.token,
        isLoading: false,
      });
      // Connect WebSocket (authenticated by the session cookie just set)
      wsService.connect();
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Login failed',
      });
      throw error;
    }
  },

  register: async (email, password, deviceName) => {
    set({ isLoading: true, error: null });
    try {
      const result = await api.register(email, password, deviceName || `Web Browser ${new Date().toLocaleDateString()}`);
      set({
        user: result.user as User,
        deviceId: result.deviceId,
        token: result.token,
        isLoading: false,
      });
      // Connect WebSocket (authenticated by the session cookie just set)
      wsService.connect();
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : 'Registration failed',
      });
      throw error;
    }
  },

  logout: async () => {
    try {
      await api.logout();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      wsService.disconnect();
      set({ user: null, deviceId: null, token: null, isLoading: false });
    }
  },

  checkAuth: async () => {
    set({ isLoading: true });
    try {
      const result = await api.getCurrentUser();
      set({
        user: result.user as User,
        deviceId: result.deviceId,
        isLoading: false,
      });
      // The token is in an httpOnly cookie we can't read, but the browser
      // sends it on the WebSocket upgrade, which is how the server
      // authenticates the socket
      wsService.connect();
    } catch (error) {
      set({ user: null, deviceId: null, token: null, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
