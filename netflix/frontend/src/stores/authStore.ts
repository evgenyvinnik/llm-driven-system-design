import { create } from 'zustand';
import { authService } from '../services/auth';
import type { Account, Profile } from '../types';

interface AuthState {
  account: Account | null;
  currentProfile: Profile | null;
  profiles: Profile[];
  isLoading: boolean;
  isAuthenticated: boolean;

  // Actions
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (email: string, password: string, name?: string) => Promise<void>;
  checkAuth: () => Promise<void>;
  loadProfiles: () => Promise<void>;
  selectProfile: (profileId: string) => Promise<void>;
  clearProfile: () => void;
}

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
