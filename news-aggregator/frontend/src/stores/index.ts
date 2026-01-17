import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, UserPreferences, Story } from '../types';
import { userApi } from '../services/api';

interface AuthState {
  user: User | null;
  preferences: UserPreferences | null;
  isLoading: boolean;
  error: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (username: string, email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  fetchUser: () => Promise<void>;
  fetchPreferences: () => Promise<void>;
  updatePreferences: (prefs: Partial<UserPreferences>) => Promise<void>;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      preferences: null,
      isLoading: false,
      error: null,

      login: async (email, password) => {
        set({ isLoading: true, error: null });
        try {
          const user = await userApi.login(email, password);
          set({ user, isLoading: false });
          await get().fetchPreferences();
        } catch (err) {
          set({ error: (err as Error).message, isLoading: false });
          throw err;
        }
      },

      register: async (username, email, password) => {
        set({ isLoading: true, error: null });
        try {
          const user = await userApi.register(username, email, password);
          set({ user, isLoading: false });
        } catch (err) {
          set({ error: (err as Error).message, isLoading: false });
          throw err;
        }
      },

      logout: async () => {
        try {
          await userApi.logout();
        } finally {
          set({ user: null, preferences: null });
        }
      },

      fetchUser: async () => {
        try {
          const user = await userApi.getMe();
          set({ user });
        } catch {
          set({ user: null });
        }
      },

      fetchPreferences: async () => {
        try {
          const preferences = await userApi.getPreferences();
          set({ preferences });
        } catch {
          // User might not be logged in
        }
      },

      updatePreferences: async (prefs) => {
        const updated = await userApi.updatePreferences(prefs);
        set({ preferences: updated });
      },
    }),
    {
      name: 'auth-storage',
      partialize: (state) => ({ user: state.user }),
    }
  )
);

interface FeedState {
  stories: Story[];
  cursor: string | null;
  hasMore: boolean;
  isLoading: boolean;
  error: string | null;
  selectedTopic: string | null;
  setStories: (stories: Story[], cursor: string | null, hasMore: boolean) => void;
  appendStories: (stories: Story[], cursor: string | null, hasMore: boolean) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setSelectedTopic: (topic: string | null) => void;
  reset: () => void;
}

export const useFeedStore = create<FeedState>((set) => ({
  stories: [],
  cursor: null,
  hasMore: true,
  isLoading: false,
  error: null,
  selectedTopic: null,

  setStories: (stories, cursor, hasMore) =>
    set({ stories, cursor, hasMore, error: null }),

  appendStories: (newStories, cursor, hasMore) =>
    set((state) => ({
      stories: [...state.stories, ...newStories],
      cursor,
      hasMore,
      error: null,
    })),

  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error, isLoading: false }),
  setSelectedTopic: (selectedTopic) => set({ selectedTopic, stories: [], cursor: null, hasMore: true }),
  reset: () => set({ stories: [], cursor: null, hasMore: true, error: null }),
}));
