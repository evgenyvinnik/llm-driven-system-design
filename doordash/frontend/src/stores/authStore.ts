import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Driver, User } from '../types';
import { authAPI } from '../services/api';

/**
 * Optional onboarding step run right after sign-up. Registration itself always
 * creates a customer; this upgrades the new account to a driver or restaurant owner.
 */
export type Onboarding =
  | { as: 'driver'; vehicleType: Driver['vehicle_type']; licensePlate?: string }
  | { as: 'restaurant_owner' };

/**
 * Authentication state interface.
 * Defines the shape of the auth store including user data,
 * loading states, and available actions.
 */
interface AuthState {
  /** Currently authenticated user, null if not logged in */
  user: User | null;
  /** Whether an auth operation is in progress */
  isLoading: boolean;
  /** Error message from the last failed auth operation */
  error: string | null;

  /**
   * Authenticates a user with email and password.
   * @param email - User's email address
   * @param password - User's password
   */
  login: (email: string, password: string) => Promise<void>;
  /**
   * Registers a new customer account, then runs the optional onboarding step.
   * @param data - Registration data
   * @param onboarding - Driver or restaurant owner onboarding to run after sign-up
   */
  register: (
    data: { email: string; password: string; name: string; phone?: string },
    onboarding?: Onboarding
  ) => Promise<void>;
  /** Logs out the current user */
  logout: () => Promise<void>;
  /** Fetches and restores the current session from the server */
  fetchUser: () => Promise<void>;
  /** Clears any stored error message */
  clearError: () => void;
}

/**
 * Global authentication store using Zustand.
 * Manages user authentication state with persistence to localStorage.
 * Provides methods for login, registration, logout, and session restoration.
 *
 * The store persists only the user object to localStorage, allowing
 * the app to show cached user info immediately while verifying the
 * session with the server.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      user: null,
      isLoading: false,
      error: null,

      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const { user } = await authAPI.login(email, password);
          set({ user, isLoading: false });
        } catch (err) {
          set({ error: (err as Error).message, isLoading: false });
          throw err;
        }
      },

      register: async (data, onboarding) => {
        set({ isLoading: true, error: null });
        try {
          const { user } = await authAPI.register(data);
          set({ user, isLoading: Boolean(onboarding) });
        } catch (err) {
          set({ error: (err as Error).message, isLoading: false });
          throw err;
        }
        if (!onboarding) return;

        // The account and session exist now, so a failure here leaves a signed-in customer
        try {
          const { user } =
            onboarding.as === 'driver'
              ? await authAPI.becomeDriver(onboarding.vehicleType, onboarding.licensePlate)
              : await authAPI.becomeRestaurantOwner();
          set({ user, isLoading: false });
        } catch (err) {
          set({
            error: `Account created as a customer, but setup failed: ${(err as Error).message}`,
            isLoading: false,
          });
          throw err;
        }
      },

      logout: async () => {
        set({ isLoading: true });
        try {
          await authAPI.logout();
        } catch {
          // Ignore logout errors
        }
        set({ user: null, isLoading: false });
      },

      fetchUser: async () => {
        set({ isLoading: true });
        try {
          const { user } = await authAPI.getMe();
          set({ user, isLoading: false });
        } catch {
          set({ user: null, isLoading: false });
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user }),
    }
  )
);
