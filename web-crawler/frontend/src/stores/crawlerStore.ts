import { create } from 'zustand';
import type { CrawlStats, FrontierUrl, CrawledPage, Domain } from '../types';
import { api } from '../services/api';

interface CrawlerStore {
  // Stats
  stats: CrawlStats | null;
  statsLoading: boolean;
  statsError: string | null;
  fetchStats: () => Promise<void>;

  // Frontier
  frontierUrls: FrontierUrl[];
  frontierLoading: boolean;
  fetchFrontierUrls: (status?: string) => Promise<void>;
  addUrls: (urls: string[], priority?: number) => Promise<{ added: number; total: number }>;

  // Pages
  pages: CrawledPage[];
  pagesTotal: number;
  pagesLoading: boolean;
  fetchPages: (limit?: number, offset?: number, domain?: string, search?: string) => Promise<void>;

  // Domains
  domains: Domain[];
  domainsTotal: number;
  domainsLoading: boolean;
  fetchDomains: (limit?: number, offset?: number) => Promise<void>;

  // Polling
  isPolling: boolean;
  startPolling: () => void;
  stopPolling: () => void;
}

let pollInterval: ReturnType<typeof setInterval> | null = null;

export const useCrawlerStore = create<CrawlerStore>((set, get) => ({
  // Stats
  stats: null,
  statsLoading: false,
  statsError: null,
  fetchStats: async () => {
    set({ statsLoading: true, statsError: null });
    try {
      const stats = await api.getStats();
      set({ stats, statsLoading: false });
    } catch (error) {
      set({
        statsError: error instanceof Error ? error.message : 'Failed to fetch stats',
        statsLoading: false,
      });
    }
  },

  // Frontier
  frontierUrls: [],
  frontierLoading: false,
  fetchFrontierUrls: async (status?: string) => {
    set({ frontierLoading: true });
    try {
      const urls = await api.getFrontierUrls(100, status);
      set({ frontierUrls: urls, frontierLoading: false });
    } catch (error) {
      console.error('Failed to fetch frontier URLs:', error);
      set({ frontierLoading: false });
    }
  },
  addUrls: async (urls: string[], priority?: number) => {
    const result = await api.addUrls(urls, priority);
    await get().fetchFrontierUrls();
    return result;
  },

  // Pages
  pages: [],
  pagesTotal: 0,
  pagesLoading: false,
  fetchPages: async (limit = 50, offset = 0, domain?: string, search?: string) => {
    set({ pagesLoading: true });
    try {
      const result = await api.getPages(limit, offset, domain, search);
      set({ pages: result.pages, pagesTotal: result.total, pagesLoading: false });
    } catch (error) {
      console.error('Failed to fetch pages:', error);
      set({ pagesLoading: false });
    }
  },

  // Domains
  domains: [],
  domainsTotal: 0,
  domainsLoading: false,
  fetchDomains: async (limit = 50, offset = 0) => {
    set({ domainsLoading: true });
    try {
      const result = await api.getDomains(limit, offset);
      set({ domains: result.domains, domainsTotal: result.total, domainsLoading: false });
    } catch (error) {
      console.error('Failed to fetch domains:', error);
      set({ domainsLoading: false });
    }
  },

  // Polling
  isPolling: false,
  startPolling: () => {
    if (pollInterval) return;
    set({ isPolling: true });
    get().fetchStats();
    pollInterval = setInterval(() => {
      get().fetchStats();
    }, 5000);
  },
  stopPolling: () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    set({ isPolling: false });
  },
}));
