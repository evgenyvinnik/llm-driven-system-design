import { create } from 'zustand';
import api from '../services/api';
import type { Business, Pagination, SearchFilters } from '../types';

interface SearchState {
  businesses: Business[];
  isLoading: boolean;
  error: string | null;
  pagination: Pagination | null;
  filters: SearchFilters;
  setFilters: (filters: Partial<SearchFilters>) => void;
  search: (filters?: SearchFilters, page?: number) => Promise<void>;
  clearSearch: () => void;
}

export const useSearchStore = create<SearchState>((set, get) => ({
  businesses: [],
  isLoading: false,
  error: null,
  pagination: null,
  filters: {},

  setFilters: (newFilters) => {
    set((state) => ({
      filters: { ...state.filters, ...newFilters },
    }));
  },

  search: async (filters?: SearchFilters, page = 1) => {
    const searchFilters = filters || get().filters;
    set({ isLoading: true, error: null });

    try {
      const params = new URLSearchParams();
      if (searchFilters.query) params.set('q', searchFilters.query);
      if (searchFilters.category) params.set('category', searchFilters.category);
      if (searchFilters.latitude) params.set('latitude', String(searchFilters.latitude));
      if (searchFilters.longitude) params.set('longitude', String(searchFilters.longitude));
      if (searchFilters.distance) params.set('distance', searchFilters.distance);
      if (searchFilters.minRating) params.set('minRating', String(searchFilters.minRating));
      if (searchFilters.maxPriceLevel) params.set('maxPriceLevel', String(searchFilters.maxPriceLevel));
      if (searchFilters.sortBy) params.set('sortBy', searchFilters.sortBy);
      params.set('page', String(page));

      const response = await api.get<{
        businesses: Business[];
        pagination: Pagination;
      }>(`/search?${params.toString()}`);

      set({
        businesses: response.businesses,
        pagination: response.pagination,
        isLoading: false,
        filters: searchFilters,
      });
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : 'Search failed',
        isLoading: false,
      });
    }
  },

  clearSearch: () => {
    set({
      businesses: [],
      pagination: null,
      filters: {},
      error: null,
    });
  },
}));
