import { create } from 'zustand';
import type { Content, ContinueWatching, WatchlistItem, RecommendationSection } from '../types';
import { contentApi, watchProgressApi, watchlistApi, recommendationsApi } from '../services/api';

interface ContentState {
  featured: Content[];
  continueWatching: ContinueWatching[];
  watchlist: WatchlistItem[];
  recommendations: RecommendationSection[];
  genres: string[];
  isLoading: boolean;
  error: string | null;

  fetchFeatured: () => Promise<void>;
  fetchContinueWatching: () => Promise<void>;
  fetchWatchlist: () => Promise<void>;
  fetchRecommendations: () => Promise<void>;
  fetchGenres: () => Promise<void>;
  addToWatchlist: (contentId: string) => Promise<void>;
  removeFromWatchlist: (contentId: string) => Promise<void>;
  updateProgress: (contentId: string, position: number, duration: number) => Promise<void>;
  clearError: () => void;
}

export const useContentStore = create<ContentState>()((set, get) => ({
  featured: [],
  continueWatching: [],
  watchlist: [],
  recommendations: [],
  genres: [],
  isLoading: false,
  error: null,

  fetchFeatured: async () => {
    try {
      const featured = await contentApi.getFeatured();
      set({ featured });
    } catch (error) {
      console.error('Failed to fetch featured:', error);
    }
  },

  fetchContinueWatching: async () => {
    try {
      const continueWatching = await watchProgressApi.getContinueWatching();
      set({ continueWatching });
    } catch (error) {
      console.error('Failed to fetch continue watching:', error);
    }
  },

  fetchWatchlist: async () => {
    try {
      const watchlist = await watchlistApi.getAll();
      set({ watchlist });
    } catch (error) {
      console.error('Failed to fetch watchlist:', error);
    }
  },

  fetchRecommendations: async () => {
    set({ isLoading: true });
    try {
      const recommendations = await recommendationsApi.getAll();
      set({ recommendations, isLoading: false });
    } catch (error) {
      console.error('Failed to fetch recommendations:', error);
      set({ isLoading: false });
    }
  },

  fetchGenres: async () => {
    try {
      const genres = await contentApi.getGenres();
      set({ genres });
    } catch (error) {
      console.error('Failed to fetch genres:', error);
    }
  },

  addToWatchlist: async (contentId: string) => {
    try {
      await watchlistApi.add(contentId);
      await get().fetchWatchlist();
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  removeFromWatchlist: async (contentId: string) => {
    try {
      await watchlistApi.remove(contentId);
      set((state) => ({
        watchlist: state.watchlist.filter((item) => item.id !== contentId),
      }));
    } catch (error) {
      set({ error: (error as Error).message });
    }
  },

  updateProgress: async (contentId: string, position: number, duration: number) => {
    try {
      await watchProgressApi.updateProgress(contentId, position, duration);
    } catch (error) {
      console.error('Failed to update progress:', error);
    }
  },

  clearError: () => set({ error: null }),
}));
