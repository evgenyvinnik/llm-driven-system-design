import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, Profile } from '../types';
import { authApi } from '../services/api';

/**
 * Authentication state interface for the auth store.
 * Manages user authentication, profile selection, and session state.
 */
interface AuthState {
  /** Currently authenticated user or null if not logged in */
  user: User | null;
  /** List of profiles associated with the current user account */
  profiles: Profile[];
  /** Currently selected profile for personalized content */
  currentProfile: Profile | null;
  /** Loading state for async authentication operations */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;

  /** Authenticates user with email and password */
  login: (email: string, password: string) => Promise<void>;
  /** Creates a new user account */
  register: (email: string, password: string, name: string) => Promise<void>;
  /** Ends the current session and clears auth state */
  logout: () => Promise<void>;
  /** Validates existing session and refreshes user data */
  checkAuth: () => Promise<void>;
  /** Sets the active profile for the session */
  selectProfile: (profile: Profile) => Promise<void>;
  /** Creates a new profile under the current account */
  createProfile: (name: string, isKids: boolean) => Promise<void>;
  /** Removes a profile from the account */
  deleteProfile: (profileId: string) => Promise<void>;
  /** Clears the current error state */
  clearError: () => void;
}

/**
 * Authentication store using Zustand with persistence.
 * Manages user sessions, multi-profile support, and authentication state.
 * The currentProfile is persisted to localStorage to restore profile selection on page reload.
 *
 * Multi-profile support allows different family members to have separate
 * watch histories, watchlists, and personalized recommendations.
 */
export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      profiles: [],
      currentProfile: null,
      // Starts true because the app always runs checkAuth() on mount. If this
      // began false, the very first render would pass the root's isLoading gate
      // with user still null, and route guards (e.g. /profiles) would redirect
      // to /login before the session-restore request even completes.
      isLoading: true,
      error: null,

      login: async (email: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const response = await authApi.login(email, password) as { user: User; profiles: Profile[] };
          set({
            user: response.user,
            profiles: response.profiles,
            isLoading: false,
          });
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      register: async (email: string, password: string, name: string) => {
        set({ isLoading: true, error: null });
        try {
          await authApi.register(email, password, name);
          set({ isLoading: false });
        } catch (error) {
          set({ error: (error as Error).message, isLoading: false });
          throw error;
        }
      },

      logout: async () => {
        try {
          await authApi.logout();
        } catch (e) {
          console.error('Logout error:', e);
        }
        set({ user: null, profiles: [], currentProfile: null });
      },

      checkAuth: async () => {
        set({ isLoading: true });
        try {
          const response = await authApi.getMe();
          set({
            user: response.user,
            profiles: response.profiles,
            isLoading: false,
          });
        } catch {
          set({ user: null, profiles: [], currentProfile: null, isLoading: false });
        }
      },

      selectProfile: async (profile: Profile) => {
        try {
          await authApi.selectProfile(profile.id);
          set({ currentProfile: profile });
        } catch (error) {
          set({ error: (error as Error).message });
          throw error;
        }
      },

      createProfile: async (name: string, isKids: boolean) => {
        try {
          const profile = await authApi.createProfile(name, isKids) as Profile;
          set((state) => ({
            profiles: [...state.profiles, profile],
          }));
        } catch (error) {
          set({ error: (error as Error).message });
          throw error;
        }
      },

      deleteProfile: async (profileId: string) => {
        try {
          await authApi.deleteProfile(profileId);
          const { currentProfile } = get();
          set((state) => ({
            profiles: state.profiles.filter((p) => p.id !== profileId),
            currentProfile: currentProfile?.id === profileId ? null : currentProfile,
          }));
        } catch (error) {
          set({ error: (error as Error).message });
          throw error;
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'appletv-auth',
      partialize: (state) => ({
        currentProfile: state.currentProfile,
      }),
    }
  )
);
