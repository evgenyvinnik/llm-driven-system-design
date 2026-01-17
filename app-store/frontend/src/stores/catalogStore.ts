/**
 * @fileoverview Catalog state management using Zustand.
 * Handles app browsing, search, categories, and reviews.
 */

import { create } from 'zustand';
import type { Category, App, PaginatedResponse, RatingSummary, Review } from '../types';
import api from '../services/api';

/**
 * Catalog store state and actions.
 */
interface CatalogState {
  /** All available categories */
  categories: Category[];
  /** Current list of apps (for listing pages) */
  apps: App[];
  /** Currently viewed app with similar apps */
  currentApp: (App & { similarApps?: Partial<App>[] }) | null;
  /** Reviews for the current app */
  currentReviews: Review[];
  /** Rating distribution for the current app */
  currentRatings: RatingSummary | null;
  /** Search results */
  searchResults: Partial<App>[];
  /** Top apps by chart type */
  topApps: { free: App[]; paid: App[]; new: App[] };
  /** Current pagination state */
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  } | null;
  /** True when a data fetch is in progress */
  isLoading: boolean;
  /** Error message from last failed operation */
  error: string | null;

  /** Fetches all categories from the API */
  fetchCategories: () => Promise<void>;
  /** Fetches a paginated list of apps */
  fetchApps: (params?: Record<string, string>) => Promise<void>;
  /** Fetches a single app by ID */
  fetchApp: (id: string) => Promise<void>;
  /** Fetches top apps for a chart type */
  fetchTopApps: (type: 'free' | 'paid' | 'new', category?: string) => Promise<void>;
  /** Performs a search query */
  searchApps: (query: string, params?: Record<string, string>) => Promise<void>;
  /** Fetches reviews for an app */
  fetchReviews: (appId: string, page?: number) => Promise<void>;
  /** Fetches rating summary for an app */
  fetchRatings: (appId: string) => Promise<void>;
  /** Clears current app data */
  clearCurrentApp: () => void;
}

/**
 * Zustand store for catalog state.
 * Manages app browsing, search, and detail views.
 */
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
