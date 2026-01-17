import type {
  CrawlStats,
  FrontierUrl,
  CrawledPage,
  Domain,
  FrontierStats,
} from '../types';

const API_BASE = '/api';

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export const api = {
  // Stats
  getStats: () => fetchApi<CrawlStats>('/stats'),
  getTimeSeries: (hours = 24) =>
    fetchApi<{ timestamps: string[]; pagesCrawled: number[]; pagesFailed: number[] }>(
      `/stats/timeseries?hours=${hours}`
    ),
  resetStats: () => fetchApi<{ message: string }>('/stats/reset', { method: 'POST' }),

  // Frontier
  getFrontierStats: () => fetchApi<FrontierStats>('/frontier/stats'),
  getFrontierUrls: (limit = 50, status?: string) => {
    let url = `/frontier/urls?limit=${limit}`;
    if (status) url += `&status=${status}`;
    return fetchApi<FrontierUrl[]>(url);
  },
  addUrls: (urls: string[], priority?: number) =>
    fetchApi<{ added: number; total: number }>('/frontier/add', {
      method: 'POST',
      body: JSON.stringify({ urls, priority }),
    }),
  addSeedUrls: (urls: string[], priority = 3) =>
    fetchApi<{ added: number; total: number }>('/frontier/seed', {
      method: 'POST',
      body: JSON.stringify({ urls, priority }),
    }),
  recoverStaleUrls: (minutes = 10) =>
    fetchApi<{ recovered: number }>(`/frontier/recover?minutes=${minutes}`, {
      method: 'POST',
    }),
  clearFrontier: () => fetchApi<{ message: string }>('/frontier/clear', { method: 'DELETE' }),

  // Pages
  getPages: (limit = 50, offset = 0, domain?: string, search?: string) => {
    let url = `/pages?limit=${limit}&offset=${offset}`;
    if (domain) url += `&domain=${encodeURIComponent(domain)}`;
    if (search) url += `&search=${encodeURIComponent(search)}`;
    return fetchApi<{ pages: CrawledPage[]; total: number; limit: number; offset: number }>(url);
  },
  getPage: (urlHash: string) => fetchApi<CrawledPage>(`/pages/${urlHash}`),
  getDomainPages: (domain: string, limit = 50) =>
    fetchApi<CrawledPage[]>(`/pages/domain/${encodeURIComponent(domain)}?limit=${limit}`),

  // Domains
  getDomains: (limit = 50, offset = 0, sortBy = 'page_count', order = 'desc') =>
    fetchApi<{ domains: Domain[]; total: number; limit: number; offset: number }>(
      `/domains?limit=${limit}&offset=${offset}&sortBy=${sortBy}&order=${order}`
    ),
  getDomain: (domain: string) => fetchApi<Domain>(`/domains/${encodeURIComponent(domain)}`),
  getDomainRobots: (domain: string) =>
    fetchApi<{ domain: string; robotsTxt: string; fetchedAt: string }>(
      `/domains/${encodeURIComponent(domain)}/robots`
    ),
  refreshRobots: (domain: string) =>
    fetchApi<{ domain: string; robotsTxt: string; fetchedAt: string; crawlDelay: number }>(
      `/domains/${encodeURIComponent(domain)}/refresh-robots`,
      { method: 'POST' }
    ),
  updateDomainSettings: (domain: string, settings: { crawlDelay?: number; isAllowed?: boolean }) =>
    fetchApi<{ message: string }>(`/domains/${encodeURIComponent(domain)}/settings`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    }),

  // Health
  getHealth: () =>
    fetchApi<{ status: string; timestamp: string; services: Record<string, string> }>('/health'),
};
