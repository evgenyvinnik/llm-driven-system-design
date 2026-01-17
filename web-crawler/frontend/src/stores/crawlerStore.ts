/**
 * @fileoverview Zustand store for crawler state management.
 *
 * This store manages the global state for the web crawler dashboard:
 * - Crawler statistics (fetched from /api/stats)
 * - Frontier URLs (fetched from /api/frontier/urls)
 * - Crawled pages (fetched from /api/pages)
 * - Domains (fetched from /api/domains)
 *
 * The store provides:
 * - Async actions for fetching data from the API
 * - Loading and error states for each data type
 * - Auto-polling for real-time dashboard updates
 *
 * Zustand was chosen over Redux for its:
 * - Minimal boilerplate
 * - Built-in TypeScript support
 * - Simple API without providers/context
 *
 * @module stores/crawlerStore
 */

import { create } from 'zustand';
import type { CrawlStats, FrontierUrl, CrawledPage, Domain } from '../types';
import { api } from '../services/api';

/**
 * State shape for the crawler store.
 * Includes data, loading/error states, and action methods.
 */
interface CrawlerStore {
  // Stats
  /** Comprehensive crawler statistics for the dashboard */
  stats: CrawlStats | null;
  /** Whether stats are currently being fetched */
  statsLoading: boolean;
  /** Error message if stats fetch failed */
  statsError: string | null;
  /** Fetches comprehensive stats from the API */
  fetchStats: () => Promise<void>;

  // Frontier
  /** URLs in the frontier (filtered by current view) */
  frontierUrls: FrontierUrl[];
  /** Whether frontier URLs are being fetched */
  frontierLoading: boolean;
  /** Fetches frontier URLs with optional status filter */
  fetchFrontierUrls: (status?: string) => Promise<void>;
  /** Adds URLs to the frontier and refreshes data */
  addUrls: (urls: string[], priority?: number) => Promise<{ added: number; total: number }>;

  // Pages
  /** Paginated list of crawled pages */
  pages: CrawledPage[];
  /** Total count of pages (for pagination) */
  pagesTotal: number;
  /** Whether pages are being fetched */
  pagesLoading: boolean;
  /** Fetches paginated pages with optional filters */
  fetchPages: (limit?: number, offset?: number, domain?: string, search?: string) => Promise<void>;

  // Domains
  /** Paginated list of domains */
  domains: Domain[];
  /** Total count of domains (for pagination) */
  domainsTotal: number;
  /** Whether domains are being fetched */
  domainsLoading: boolean;
  /** Fetches paginated domains */
  fetchDomains: (limit?: number, offset?: number) => Promise<void>;

  // Polling
  /** Whether auto-polling is active */
  isPolling: boolean;
  /** Starts auto-polling for stats (every 5 seconds) */
  startPolling: () => void;
  /** Stops auto-polling */
  stopPolling: () => void;
}

/**
 * Module-level polling interval reference.
 * Stored outside the store to persist across renders.
 */
let pollInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Zustand store for crawler state.
 *
 * Provides centralized state management for all dashboard components.
 * Components can subscribe to specific slices of state to minimize re-renders.
 *
 * @example
 * ```typescript
 * import { useCrawlerStore } from './stores/crawlerStore';
 *
 * function Dashboard() {
 *   const { stats, statsLoading, fetchStats, startPolling, stopPolling } = useCrawlerStore();
 *
 *   useEffect(() => {
 *     fetchStats();
 *     startPolling();
 *     return () => stopPolling();
 *   }, [fetchStats, startPolling, stopPolling]);
 *
 *   if (statsLoading) return <Spinner />;
 *   return <StatsDisplay stats={stats} />;
 * }
 * ```
 */
export const useCrawlerStore = create<CrawlerStore>((set, get) => ({
  // Stats
  stats: null,
  statsLoading: false,
  statsError: null,

  /**
   * Fetches comprehensive crawler statistics.
   * Sets loading state and error state appropriately.
   */
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

  /**
   * Fetches frontier URLs with optional status filter.
   * Used by the Frontier view to display queue contents.
   *
   * @param status - Optional status filter (pending, in_progress, completed, failed)
   */
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

  /**
   * Adds URLs to the frontier and refreshes the list.
   * Returns the result with added count.
   *
   * @param urls - Array of URLs to add
   * @param priority - Optional priority level (1-3)
   * @returns Object with added and total counts
   */
  addUrls: async (urls: string[], priority?: number) => {
    const result = await api.addUrls(urls, priority);
    await get().fetchFrontierUrls();
    return result;
  },

  // Pages
  pages: [],
  pagesTotal: 0,
  pagesLoading: false,

  /**
   * Fetches paginated crawled pages with optional filters.
   * Used by the Pages view for browsing crawled content.
   *
   * @param limit - Maximum pages to return (default: 50)
   * @param offset - Number of pages to skip (default: 0)
   * @param domain - Optional domain filter
   * @param search - Optional search term for URL/title
   */
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

  /**
   * Fetches paginated domains.
   * Used by the Domains view.
   *
   * @param limit - Maximum domains to return (default: 50)
   * @param offset - Number of domains to skip (default: 0)
   */
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

  /**
   * Starts auto-polling for stats.
   * Fetches stats every 5 seconds for real-time dashboard updates.
   * Only one polling interval is active at a time.
   */
  startPolling: () => {
    if (pollInterval) return;
    set({ isPolling: true });
    get().fetchStats();
    pollInterval = setInterval(() => {
      get().fetchStats();
    }, 5000);
  },

  /**
   * Stops auto-polling.
   * Should be called when the dashboard is unmounted.
   */
  stopPolling: () => {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    set({ isPolling: false });
  },
}));
