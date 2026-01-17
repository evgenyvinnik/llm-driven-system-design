import { create } from 'zustand';
import { api } from '../services/api';
import type { SearchResult, SearchFilters, SearchSuggestion } from '../types';

interface SearchState {
  query: string;
  filters: SearchFilters;
  results: SearchResult[];
  suggestions: SearchSuggestion[];
  trending: string[];
  recentSearches: string[];
  isLoading: boolean;
  isSuggestionsLoading: boolean;
  error: string | null;
  totalResults: number;
  nextCursor: string | undefined;
  searchTime: number;

  setQuery: (query: string) => void;
  setFilters: (filters: SearchFilters) => void;
  search: (query?: string) => Promise<void>;
  loadMore: () => Promise<void>;
  fetchSuggestions: (query: string) => Promise<void>;
  fetchTrending: () => Promise<void>;
  fetchRecentSearches: () => Promise<void>;
  clearResults: () => void;
  clearSuggestions: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  query: '',
  filters: {},
  results: [],
  suggestions: [],
  trending: [],
  recentSearches: [],
  isLoading: false,
  isSuggestionsLoading: false,
  error: null,
  totalResults: 0,
  nextCursor: undefined,
  searchTime: 0,

  setQuery: (query: string) => set({ query }),

  setFilters: (filters: SearchFilters) => set({ filters }),

  search: async (searchQuery?: string) => {
    const query = searchQuery ?? get().query;
    const filters = get().filters;

    if (!query.trim() && Object.keys(filters).length === 0) {
      set({ results: [], totalResults: 0, nextCursor: undefined });
      return;
    }

    set({ isLoading: true, error: null, query });

    try {
      const response = await api.search(query, filters);
      set({
        results: response.results,
        totalResults: response.total_estimate,
        nextCursor: response.next_cursor,
        searchTime: response.took_ms,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Search failed',
        isLoading: false,
      });
    }
  },

  loadMore: async () => {
    const { query, filters, nextCursor, results } = get();
    if (!nextCursor) return;

    set({ isLoading: true });

    try {
      const response = await api.search(query, filters, nextCursor);
      set({
        results: [...results, ...response.results],
        nextCursor: response.next_cursor,
        isLoading: false,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Failed to load more',
        isLoading: false,
      });
    }
  },

  fetchSuggestions: async (query: string) => {
    if (query.length < 2) {
      set({ suggestions: [] });
      return;
    }

    set({ isSuggestionsLoading: true });

    try {
      const response = await api.getSuggestions(query);
      set({ suggestions: response.suggestions, isSuggestionsLoading: false });
    } catch {
      set({ suggestions: [], isSuggestionsLoading: false });
    }
  },

  fetchTrending: async () => {
    try {
      const response = await api.getTrending();
      set({ trending: response.trending });
    } catch {
      // Ignore errors
    }
  },

  fetchRecentSearches: async () => {
    try {
      const response = await api.getRecentSearches();
      set({ recentSearches: response.searches });
    } catch {
      // Ignore errors
    }
  },

  clearResults: () => set({ results: [], totalResults: 0, nextCursor: undefined }),

  clearSuggestions: () => set({ suggestions: [] }),
}));
