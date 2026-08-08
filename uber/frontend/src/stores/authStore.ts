import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { User } from '../types';
import api from '../services/api';
import wsService from '../services/websocket';

/**
 * Authentication state interface for the Zustand store.
 * Manages user session, authentication state, and login/registration actions.
 */
interface AuthState {
  /** Currently authenticated user or null if not logged in */
  user: User | null;
  /** JWT token for API authentication */
  token: string | null;
  /** Whether an authentication operation is in progress */
  isLoading: boolean;
  /** Error message from the last failed authentication attempt */
  error: string | null;
  /**
   * Whether the initial session-restore attempt has finished.
   *
   * Only the token is persisted, so `user` is always null on a fresh page load
   * until `checkAuth` resolves. Route guards must wait for this flag rather
   * than reading `user` directly, or they redirect authenticated users to
   * /login on every reload and deep link.
   */
  authResolved: boolean;

  /**
   * Authenticate user with email and password.
   * @param email - User's email address
   * @param password - User's password
   */
  login: (email: string, password: string) => Promise<void>;

  /**
   * Register a new rider account.
   * @param email - Email address for the new account
   * @param password - Password for the new account
   * @param name - User's display name
   * @param phone - Optional phone number
   */
  registerRider: (email: string, password: string, name: string, phone?: string) => Promise<void>;

  /**
   * Register a new driver account with vehicle information.
   * @param email - Email address for the new account
   * @param password - Password for the new account
   * @param name - Driver's display name
   * @param phone - Driver's phone number
   * @param vehicle - Vehicle details for ride matching
   */
  registerDriver: (
    email: string,
    password: string,
    name: string,
    phone: string,
    vehicle: {
      vehicleType: string;
      vehicleMake: string;
      vehicleModel: string;
      vehicleColor: string;
      licensePlate: string;
    }
  ) => Promise<void>;

  /** End the current user session */
  logout: () => Promise<void>;

  /** Verify existing token and restore session on app startup */
  checkAuth: () => Promise<void>;

  /** Clear any authentication error messages */
  clearError: () => void;
}

/**
 * Zustand store for authentication state management.
 * Handles user login, registration, and session persistence.
 *
 * Key features:
 * - Persists token to localStorage for session restoration
 * - Automatically connects WebSocket on successful authentication
 * - Supports both rider and driver registration flows
 *
 * @example
 * ```tsx
 * const { user, login, logout } = useAuthStore();
 *
 * // Login
 * await login('user@example.com', 'password');
 *
 * // Check if authenticated
 * if (user) {
 *   console.log(`Logged in as ${user.name}`);
 * }
 * ```
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, _get) => ({
      user: null,
      token: null,
      isLoading: false,
      error: null,
      authResolved: false,

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.auth.login(email, password);
          const user = result.user as User;
          const token = result.token;

          localStorage.setItem('token', token);
          set({ user, token, isLoading: false, authResolved: true });

          // Connect WebSocket for real-time updates
          wsService.connect(token).catch(console.error);
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      registerRider: async (email: string, password: string, name: string, phone?: string) => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.auth.registerRider({ email, password, name, phone });
          const user = result.user as User;
          const token = result.token;

          localStorage.setItem('token', token);
          set({ user, token, isLoading: false });

          wsService.connect(token).catch(console.error);
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      registerDriver: async (email, password, name, phone, vehicle) => {
        set({ isLoading: true, error: null });
        try {
          const result = await api.auth.registerDriver({ email, password, name, phone, vehicle });
          const user = result.user as User;
          const token = result.token;

          localStorage.setItem('token', token);
          set({ user, token, isLoading: false });

          wsService.connect(token).catch(console.error);
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await api.auth.logout();
        } catch {
          // Ignore errors during logout - proceed with local cleanup
        }

        localStorage.removeItem('token');
        wsService.disconnect();
        set({ user: null, token: null });
      },

      checkAuth: async () => {
        const token = localStorage.getItem('token');
        if (!token) {
          set({ user: null, token: null, authResolved: true });
          return;
        }

        try {
          const result = await api.auth.me();
          const user = result.user as User;
          set({ user, token, authResolved: true });

          // Reconnect WebSocket with existing token
          wsService.connect(token).catch(console.error);
        } catch {
          // Token invalid or expired - clear session
          localStorage.removeItem('token');
          set({ user: null, token: null, authResolved: true });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'uber-auth',
      // Only persist the token, not the full user object
      partialize: (state) => ({ token: state.token }),
    }
  )
);
