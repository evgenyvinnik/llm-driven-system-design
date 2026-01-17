/**
 * Authentication Store
 *
 * Global state for authentication using Zustand.
 * Manages account, profile selection, and authentication flow.
 */
import { create } from 'zustand';
import { authService } from '../services/auth';
import type { Account, Profile } from '../types';

/**
 * Authentication state interface.
 * Contains account/profile data and actions for auth management.
 */
interface AuthState {
  account: Account | null;
  currentProfile: Profile | null;
  profiles: Profile[];
  isLoading: boolean;
  isAuthenticated: boolean;

  // Actions
  /** Authenticates user with email and password */
  login: (email: string, password: string) => Promise<void>;
  /** Logs out user and clears all auth state */
  logout: () => Promise<void>;
  /** Creates new account and logs in */
  register: (email: string, password: string, name?: string) => Promise<void>;
  /** Restores auth state from session on page load */
  checkAuth: () => Promise<void>;
  /** Loads profiles for current account */
  loadProfiles: () => Promise<void>;
  /** Selects a profile for the current session */
  selectProfile: (profileId: string) => Promise<void>;
  /** Clears selected profile (returns to profile selection) */
  clearProfile: () => void;
}

/**
 * Authentication store hook.
 * Use this hook to access auth state and actions in components.
 */
export const useAuthStore = create<AuthState>((set, get) => ({
  account: null,
  currentProfile: null,
  profiles: [],
  isLoading: true,
  isAuthenticated: false,

  login: async (email, password) => {
    const { account } = await authService.login(email, password);
    set({ account, isAuthenticated: true });
    await get().loadProfiles();
  },

  logout: async () => {
    await authService.logout();
    set({
      account: null,
      currentProfile: null,
      profiles: [],
      isAuthenticated: false,
    });
  },

  register: async (email, password, name) => {
    const { account } = await authService.register(email, password, name);
    set({ account, isAuthenticated: true });
    await get().loadProfiles();
  },

  checkAuth: async () => {
    try {
      const { account, currentProfile } = await authService.getMe();
      set({
        account,
        currentProfile,
        isAuthenticated: true,
        isLoading: false,
      });
      await get().loadProfiles();
    } catch {
      set({
        account: null,
        currentProfile: null,
        isAuthenticated: false,
        isLoading: false,
      });
    }
  },

  loadProfiles: async () => {
    try {
      const { profiles } = await authService.getProfiles();
      set({ profiles });
    } catch (error) {
      console.error('Failed to load profiles:', error);
    }
  },

  selectProfile: async (profileId) => {
    const { profile } = await authService.selectProfile(profileId);
    set({ currentProfile: profile });
  },

  clearProfile: () => {
    set({ currentProfile: null });
  },
}));
