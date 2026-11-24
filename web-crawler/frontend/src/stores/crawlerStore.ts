/**
 * @fileoverview Zustand store for crawler state management.
 *
 * This store manages the global state for the web crawler dashboard:
 * - Crawler statistics (polled from /api/stats)
 * - Frontier URLs (fetched from /api/frontier/urls)
 * - Crawled pages (fetched from /api/pages)
 * - Domains (fetched from /api/domains)
 *
 * Stats polling is written to be trustworthy rather than merely periodic:
 * - **Settle-then-schedule** (not setInterval): the next poll is scheduled only
 *   after the current one finishes, so a slow backend can't stack requests
 * - **Out-of-order protection**: each request gets a sequence number and an
 *   older response never overwrites a newer snapshot
 * - **Visibility pause**: no polling while the tab is hidden; an immediate
 *   poll when it becomes visible again
 * - **Backoff**: 5s → 10s → 20s → … capped at 60s while the backend is failing
 * - **Data age**: `statsFetchedAt` lets the UI show "updated 3s ago" and flip
 *   to a stale state instead of presenting old numbers as live
 *
 * @module stores/crawlerStore
 */

import { create } from 'zustand';
import type { CrawlStats, FrontierUrl, CrawledPage, Domain } from '../types';
import { api } from '../services/api';

/** Normal polling interval. */
export const POLL_INTERVAL_MS = 5000;
/** Backoff ceiling while the backend is unreachable. */
const MAX_POLL_INTERVAL_MS = 60000;

/**
 * State shape for the crawler store.
 */
interface CrawlerStore {
  // Stats
  /** Latest stats snapshot (kept on screen through failed polls) */
  stats: CrawlStats | null;
  /** Whether a stats request is in flight */
  statsLoading: boolean;
  /** Error message from the most recent failed poll, if any */
  statsError: string | null;
  /** Browser time (ms) when the current snapshot arrived */
  statsFetchedAt: number | null;
  /** Consecutive failed polls; drives backoff and the stale indicator */
  consecutiveErrors: number;
  /** Fetches stats once */
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
  /** Replaces one domain in the list after a confirmed settings update */
  replaceDomain: (domain: Domain) => void;

  // Polling
  isPolling: boolean;
  /** Delay before the next poll (grows with consecutive errors) */
  nextPollInMs: number;
  startPolling: () => void;
  stopPolling: () => void;
}

let pollTimer: ReturnType<typeof setTimeout> | null = null;
/** Monotonic id of the latest stats request; older responses are discarded. */
let statsRequestSeq = 0;
let visibilityListener: (() => void) | null = null;

/**
 * Poll delay for a given number of consecutive failures.
 */
export function pollDelay(consecutiveErrors: number): number {
  return Math.min(POLL_INTERVAL_MS * 2 ** consecutiveErrors, MAX_POLL_INTERVAL_MS);
}

/**
 * Global crawler store hook.
 *
 * @example
 * ```tsx
 * function Dashboard() {
 *   const { stats, startPolling, stopPolling } = useCrawlerStore();
 *   useEffect(() => {
 *     startPolling();
 *     return () => stopPolling();
 *   }, [startPolling, stopPolling]);
 * }
 * ```
 */
export const useCrawlerStore = create<CrawlerStore>((set, get) => ({
  // Stats
  stats: null,
  statsLoading: false,
  statsError: null,
  statsFetchedAt: null,
  consecutiveErrors: 0,

  fetchStats: async () => {
    const seq = ++statsRequestSeq;
    set({ statsLoading: true });
    try {
      const stats = await api.getStats();
      // A slower, older request must not overwrite a newer snapshot
      if (seq !== statsRequestSeq) return;
      set({
        stats,
        statsLoading: false,
        statsError: null,
        statsFetchedAt: Date.now(),
        consecutiveErrors: 0,
      });
    } catch (error) {
      if (seq !== statsRequestSeq) return;
      // Keep the last snapshot; the UI marks it stale by its age
      set((state) => ({
        statsError: error instanceof Error ? error.message : 'Failed to fetch stats',
        statsLoading: false,
        consecutiveErrors: state.consecutiveErrors + 1,
      }));
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

  replaceDomain: (updated: Domain) => {
    set((state) => ({
      domains: state.domains.map((d) => (d.domain === updated.domain ? updated : d)),
    }));
  },

  // Polling
  isPolling: false,
  nextPollInMs: POLL_INTERVAL_MS,

  startPolling: () => {
    if (get().isPolling) return;
    set({ isPolling: true });

    const tick = async () => {
      pollTimer = null;
      if (!get().isPolling) return;
      if (document.hidden) return; // resumed by the visibility listener
      await get().fetchStats();
      if (!get().isPolling || pollTimer) return;
      const delay = pollDelay(get().consecutiveErrors);
      set({ nextPollInMs: delay });
      pollTimer = setTimeout(tick, delay);
    };

    visibilityListener = () => {
      if (document.hidden) {
        if (pollTimer) {
          clearTimeout(pollTimer);
          pollTimer = null;
        }
      } else if (get().isPolling && !pollTimer) {
        tick();
      }
    };
    document.addEventListener('visibilitychange', visibilityListener);

    tick();
  },

  stopPolling: () => {
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    if (visibilityListener) {
      document.removeEventListener('visibilitychange', visibilityListener);
      visibilityListener = null;
    }
    set({ isPolling: false });
  },
}));
