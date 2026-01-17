import { create } from 'zustand';
import { videoService } from '../services/videos';
import type { Video, HomepageRow, ContinueWatchingItem } from '../types';

interface BrowseState {
  homepageRows: HomepageRow[];
  continueWatching: ContinueWatchingItem[];
  myList: Video[];
  searchResults: Video[];
  genres: string[];
  isLoading: boolean;
  error: string | null;

  // Actions
  loadHomepage: () => Promise<void>;
  loadContinueWatching: () => Promise<void>;
  loadMyList: () => Promise<void>;
  loadGenres: () => Promise<void>;
  search: (query: string) => Promise<void>;
  clearSearch: () => void;
  addToMyList: (videoId: string) => Promise<void>;
  removeFromMyList: (videoId: string) => Promise<void>;
}

export const useBrowseStore = create<BrowseState>((set) => ({
  homepageRows: [],
  continueWatching: [],
  myList: [],
  searchResults: [],
  genres: [],
  isLoading: false,
  error: null,

  loadHomepage: async () => {
    set({ isLoading: true, error: null });
    try {
      const { rows } = await videoService.getHomepage();
      set({ homepageRows: rows, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  loadContinueWatching: async () => {
    try {
      const { items } = await videoService.getContinueWatching();
      set({ continueWatching: items });
    } catch (error) {
      console.error('Failed to load continue watching:', error);
    }
  },

  loadMyList: async () => {
    try {
      const { items } = await videoService.getMyList();
      set({ myList: items });
    } catch (error) {
      console.error('Failed to load my list:', error);
    }
  },

  loadGenres: async () => {
    try {
      const { genres } = await videoService.getGenres();
      set({ genres });
    } catch (error) {
      console.error('Failed to load genres:', error);
    }
  },

  search: async (query) => {
    if (!query.trim()) {
      set({ searchResults: [] });
      return;
    }

    set({ isLoading: true });
    try {
      const { videos } = await videoService.search(query);
      set({ searchResults: videos, isLoading: false });
    } catch (error) {
      set({ error: (error as Error).message, isLoading: false });
    }
  },

  clearSearch: () => {
    set({ searchResults: [] });
  },

  addToMyList: async (videoId) => {
    try {
      await videoService.addToMyList(videoId);
      // Reload my list
      const { items } = await videoService.getMyList();
      set({ myList: items });
    } catch (error) {
      console.error('Failed to add to my list:', error);
    }
  },

  removeFromMyList: async (videoId) => {
    try {
      await videoService.removeFromMyList(videoId);
      set((state) => ({
        myList: state.myList.filter((v) => v.id !== videoId),
      }));
    } catch (error) {
      console.error('Failed to remove from my list:', error);
    }
  },
}));
