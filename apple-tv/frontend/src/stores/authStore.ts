import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, Profile } from '../types';
import { authApi } from '../services/api';

interface AuthState {
  user: User | null;
  profiles: Profile[];
  currentProfile: Profile | null;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, name: string) => Promise<void>;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
  selectProfile: (profile: Profile) => Promise<void>;
  createProfile: (name: string, isKids: boolean) => Promise<void>;
  deleteProfile: (profileId: string) => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      profiles: [],
      currentProfile: null,
      isLoading: false,
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
