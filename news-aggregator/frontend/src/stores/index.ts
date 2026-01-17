/**
 * Zustand state stores for the News Aggregator frontend.
 * Manages authentication state and feed pagination.
 * @module stores
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { User, UserPreferences, Story } from '../types';
import { userApi } from '../services/api';

/**
 * Authentication store state interface.
 * Manages user session, preferences, and auth operations.
 */
interface AuthState {
  /** Currently authenticated user (null if logged out) */
  user: User | null;
  /** User's personalization preferences */
  preferences: UserPreferences | null;
  /** Whether an auth operation is in progress */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;
  /**
   * Login with email and password.
   * On success, fetches user preferences.
   */
  login: (email: string, password: string) => Promise<void>;
  /**
   * Register a new user account.
   * On success, sets user state.
   */
  register: (username: string, email: string, password: string) => Promise<void>;
  /**
   * Logout and clear session.
   * Clears both user and preferences.
   */
  logout: () => Promise<void>;
  /**
   * Fetch current user from API.
   * Used to restore session on page load.
   */
  fetchUser: () => Promise<void>;
  /**
   * Fetch user preferences from API.
   * Called after login to enable personalization.
   */
  fetchPreferences: () => Promise<void>;
  /**
   * Update user preferences.
   * @param prefs - Partial preferences to update
   */
  updatePreferences: (prefs: Partial<UserPreferences>) => Promise<void>;
}

/**
 * Authentication store.
 * Persists user data to localStorage for session restoration.
 * Uses Zustand with persist middleware.
 */
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

/**
 * Feed store state interface.
 * Manages story list, pagination, and topic filtering.
 */
interface FeedState {
  /** Current list of stories in the feed */
  stories: Story[];
  /** Pagination cursor for next page */
  cursor: string | null;
  /** Whether more stories are available */
  hasMore: boolean;
  /** Whether feed is currently loading */
  isLoading: boolean;
  /** Error message from last failed fetch */
  error: string | null;
  /** Currently selected topic filter (null for all) */
  selectedTopic: string | null;
  /**
   * Replace stories with new data (used for initial load and refresh).
   * @param stories - New story array
   * @param cursor - Next page cursor
   * @param hasMore - Whether more pages exist
   */
  setStories: (stories: Story[], cursor: string | null, hasMore: boolean) => void;
  /**
   * Append stories to existing list (used for infinite scroll).
   * @param stories - Additional stories to add
   * @param cursor - Next page cursor
   * @param hasMore - Whether more pages exist
   */
  appendStories: (stories: Story[], cursor: string | null, hasMore: boolean) => void;
  /**
   * Set loading state.
   * @param loading - Whether loading is in progress
   */
  setLoading: (loading: boolean) => void;
  /**
   * Set error state.
   * @param error - Error message or null to clear
   */
  setError: (error: string | null) => void;
  /**
   * Set selected topic filter.
   * Resets stories when topic changes.
   * @param topic - Topic name or null for all topics
   */
  setSelectedTopic: (topic: string | null) => void;
  /**
   * Reset feed to initial state.
   * Used when navigating away from feed.
   */
  reset: () => void;
}

/**
 * Feed store.
 * Manages news feed state including stories, pagination, and topic filtering.
 * Does not persist to storage (always starts fresh).
 */
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
