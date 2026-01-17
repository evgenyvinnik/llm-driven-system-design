import { create } from 'zustand';
import { Url, CreateUrlInput } from '../types';
import { api } from '../services/api';

interface UrlState {
  urls: Url[];
  total: number;
  isLoading: boolean;
  error: string | null;
  createdUrl: Url | null;

  createUrl: (data: CreateUrlInput) => Promise<boolean>;
  loadUrls: (limit?: number, offset?: number) => Promise<void>;
  deleteUrl: (shortCode: string) => Promise<boolean>;
  clearCreatedUrl: () => void;
  clearError: () => void;
}

export const useUrlStore = create<UrlState>()((set, get) => ({
  urls: [],
  total: 0,
  isLoading: false,
  error: null,
  createdUrl: null,

  createUrl: async (data: CreateUrlInput) => {
    set({ isLoading: true, error: null });
    try {
      const url = await api.urls.create(data);
      set((state) => ({
        urls: [url, ...state.urls],
        total: state.total + 1,
        createdUrl: url,
        isLoading: false,
      }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to create URL';
      set({ error: message, isLoading: false });
      return false;
    }
  },

  loadUrls: async (limit = 50, offset = 0) => {
    set({ isLoading: true, error: null });
    try {
      const { urls, total } = await api.urls.list(limit, offset);
      set({ urls, total, isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load URLs';
      set({ error: message, isLoading: false });
    }
  },

  deleteUrl: async (shortCode: string) => {
    set({ isLoading: true, error: null });
    try {
      await api.urls.delete(shortCode);
      set((state) => ({
        urls: state.urls.filter((u) => u.short_code !== shortCode),
        total: state.total - 1,
        isLoading: false,
      }));
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to delete URL';
      set({ error: message, isLoading: false });
      return false;
    }
  },

  clearCreatedUrl: () => set({ createdUrl: null }),

  clearError: () => set({ error: null }),
}));
