import { create } from 'zustand';
import type { SearchResponse } from '@/types';
import { searchApi } from '@/services/api';

interface SearchState {
  query: string;
  results: SearchResponse | null;
  isLoading: boolean;
  error: string | null;
  recentSearches: string[];
  setQuery: (query: string) => void;
  search: (query: string, page?: number) => Promise<void>;
  clearResults: () => void;
  addRecentSearch: (query: string) => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  results: null,
  isLoading: false,
  error: null,
  recentSearches: JSON.parse(localStorage.getItem('recentSearches') || '[]'),

  setQuery: (query) => set({ query }),

  search: async (query, page = 1) => {
    if (!query.trim()) {
      set({ results: null, error: null });
      return;
    }

    set({ isLoading: true, error: null, query });

    try {
      const results = await searchApi.search(query, page);
      set({ results, isLoading: false });
      get().addRecentSearch(query);
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Search failed',
        isLoading: false,
      });
    }
  },

  clearResults: () => set({ results: null, error: null }),

  addRecentSearch: (query) => {
    const recent = get().recentSearches;
    const filtered = recent.filter((q) => q !== query);
    const updated = [query, ...filtered].slice(0, 10);
    localStorage.setItem('recentSearches', JSON.stringify(updated));
    set({ recentSearches: updated });
  },
}));
