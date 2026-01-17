import { create } from 'zustand';
import type { Category, App, PaginatedResponse, RatingSummary, Review } from '../types';
import api from '../services/api';

interface CatalogState {
  categories: Category[];
  apps: App[];
  currentApp: (App & { similarApps?: Partial<App>[] }) | null;
  currentReviews: Review[];
  currentRatings: RatingSummary | null;
  searchResults: Partial<App>[];
  topApps: { free: App[]; paid: App[]; new: App[] };
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  } | null;
  isLoading: boolean;
  error: string | null;

  fetchCategories: () => Promise<void>;
  fetchApps: (params?: Record<string, string>) => Promise<void>;
  fetchApp: (id: string) => Promise<void>;
  fetchTopApps: (type: 'free' | 'paid' | 'new', category?: string) => Promise<void>;
  searchApps: (query: string, params?: Record<string, string>) => Promise<void>;
  fetchReviews: (appId: string, page?: number) => Promise<void>;
  fetchRatings: (appId: string) => Promise<void>;
  clearCurrentApp: () => void;
}

export const useCatalogStore = create<CatalogState>((set, get) => ({
  categories: [],
  apps: [],
  currentApp: null,
  currentReviews: [],
  currentRatings: null,
  searchResults: [],
  topApps: { free: [], paid: [], new: [] },
  pagination: null,
  isLoading: false,
  error: null,

  fetchCategories: async () => {
    try {
      const response = await api.get<{ data: Category[] }>('/categories');
      set({ categories: response.data });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch categories' });
    }
  },

  fetchApps: async (params = {}) => {
    set({ isLoading: true, error: null });
    try {
      const queryString = new URLSearchParams(params).toString();
      const response = await api.get<PaginatedResponse<App>>(`/apps?${queryString}`);
      set({ apps: response.data, pagination: response.pagination, isLoading: false });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch apps', isLoading: false });
    }
  },

  fetchApp: async (id: string) => {
    set({ isLoading: true, error: null });
    try {
      const response = await api.get<{ data: App & { similarApps?: Partial<App>[] } }>(`/apps/${id}`);
      set({ currentApp: response.data, isLoading: false });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Failed to fetch app', isLoading: false });
    }
  },

  fetchTopApps: async (type: 'free' | 'paid' | 'new', category?: string) => {
    try {
      const params = new URLSearchParams({ type, limit: '10' });
      if (category) params.set('category', category);
      const response = await api.get<{ data: App[] }>(`/apps/top?${params}`);
      set((state) => ({
        topApps: { ...state.topApps, [type]: response.data },
      }));
    } catch (error) {
      console.error('Failed to fetch top apps:', error);
    }
  },

  searchApps: async (query: string, params = {}) => {
    set({ isLoading: true, error: null });
    try {
      const queryParams = new URLSearchParams({ q: query, ...params });
      const response = await api.get<PaginatedResponse<Partial<App>>>(`/apps/search?${queryParams}`);
      set({ searchResults: response.data, pagination: response.pagination, isLoading: false });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Search failed', isLoading: false });
    }
  },

  fetchReviews: async (appId: string, page = 1) => {
    try {
      const response = await api.get<PaginatedResponse<Review>>(`/apps/${appId}/reviews?page=${page}`);
      set({ currentReviews: response.data });
    } catch (error) {
      console.error('Failed to fetch reviews:', error);
    }
  },

  fetchRatings: async (appId: string) => {
    try {
      const response = await api.get<{ data: RatingSummary }>(`/apps/${appId}/ratings`);
      set({ currentRatings: response.data });
    } catch (error) {
      console.error('Failed to fetch ratings:', error);
    }
  },

  clearCurrentApp: () => {
    set({ currentApp: null, currentReviews: [], currentRatings: null });
  },
}));
