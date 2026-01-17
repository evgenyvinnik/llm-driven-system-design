import type { SearchResponse, AutocompleteResponse, PopularSearchesResponse, SystemStats } from '@/types';

const API_BASE = '/api';

export const searchApi = {
  /**
   * Search for documents
   */
  search: async (query: string, page = 1, limit = 10): Promise<SearchResponse> => {
    const params = new URLSearchParams({
      q: query,
      page: page.toString(),
      limit: limit.toString(),
    });
    const response = await fetch(`${API_BASE}/search?${params}`);
    if (!response.ok) {
      throw new Error('Search failed');
    }
    return response.json();
  },

  /**
   * Get autocomplete suggestions
   */
  autocomplete: async (query: string): Promise<AutocompleteResponse> => {
    const params = new URLSearchParams({ q: query });
    const response = await fetch(`${API_BASE}/search/autocomplete?${params}`);
    if (!response.ok) {
      throw new Error('Autocomplete failed');
    }
    return response.json();
  },

  /**
   * Get popular searches
   */
  popularSearches: async (limit = 10): Promise<PopularSearchesResponse> => {
    const params = new URLSearchParams({ limit: limit.toString() });
    const response = await fetch(`${API_BASE}/search/popular?${params}`);
    if (!response.ok) {
      throw new Error('Failed to get popular searches');
    }
    return response.json();
  },

  /**
   * Get related searches
   */
  relatedSearches: async (query: string, limit = 5): Promise<{ related: string[] }> => {
    const params = new URLSearchParams({ q: query, limit: limit.toString() });
    const response = await fetch(`${API_BASE}/search/related?${params}`);
    if (!response.ok) {
      throw new Error('Failed to get related searches');
    }
    return response.json();
  },
};

export const adminApi = {
  /**
   * Get system stats
   */
  getStats: async (): Promise<SystemStats> => {
    const response = await fetch(`${API_BASE}/admin/stats`);
    if (!response.ok) {
      throw new Error('Failed to get stats');
    }
    return response.json();
  },

  /**
   * Add seed URLs
   */
  seedUrls: async (urls: string[]): Promise<{ message: string }> => {
    const response = await fetch(`${API_BASE}/admin/crawl/seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls }),
    });
    if (!response.ok) {
      throw new Error('Failed to seed URLs');
    }
    return response.json();
  },

  /**
   * Start crawler
   */
  startCrawl: async (maxPages = 100): Promise<{ message: string }> => {
    const response = await fetch(`${API_BASE}/admin/crawl/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxPages }),
    });
    if (!response.ok) {
      throw new Error('Failed to start crawler');
    }
    return response.json();
  },

  /**
   * Build search index
   */
  buildIndex: async (): Promise<{ message: string }> => {
    const response = await fetch(`${API_BASE}/admin/index/build`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error('Failed to build index');
    }
    return response.json();
  },

  /**
   * Calculate PageRank
   */
  calculatePageRank: async (): Promise<{ message: string }> => {
    const response = await fetch(`${API_BASE}/admin/pagerank/calculate`, {
      method: 'POST',
    });
    if (!response.ok) {
      throw new Error('Failed to calculate PageRank');
    }
    return response.json();
  },
};
