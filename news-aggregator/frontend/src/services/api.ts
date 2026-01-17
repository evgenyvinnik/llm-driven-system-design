const API_BASE = '/api/v1';

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

// Feed API
export const feedApi = {
  getFeed: (cursor?: string, limit = 20) =>
    fetchApi<{ stories: import('../types').Story[]; next_cursor: string | null; has_more: boolean }>(
      `/feed?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) })}`
    ),

  getTopicFeed: (topic: string, cursor?: string, limit = 20) =>
    fetchApi<{ stories: import('../types').Story[]; next_cursor: string | null; has_more: boolean }>(
      `/feed/topic/${encodeURIComponent(topic)}?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) })}`
    ),

  getBreaking: () =>
    fetchApi<{ stories: import('../types').Story[] }>('/breaking'),

  getTrending: () =>
    fetchApi<{ stories: import('../types').Story[] }>('/trending'),

  getStory: (id: string) =>
    fetchApi<import('../types').Story>(`/stories/${id}`),

  getStoryArticles: (id: string, limit = 20) =>
    fetchApi<{ articles: import('../types').Article[] }>(`/stories/${id}/articles?limit=${limit}`),

  search: (query: string, options?: { topics?: string[]; dateFrom?: string; dateTo?: string; limit?: number }) => {
    const params = new URLSearchParams({ q: query });
    if (options?.topics?.length) params.set('topics', options.topics.join(','));
    if (options?.dateFrom) params.set('date_from', options.dateFrom);
    if (options?.dateTo) params.set('date_to', options.dateTo);
    if (options?.limit) params.set('limit', String(options.limit));
    return fetchApi<{ articles: import('../types').Article[] }>(`/search?${params}`);
  },

  getTopics: () =>
    fetchApi<{ topics: import('../types').Topic[] }>('/topics'),
};

// User API
export const userApi = {
  register: (username: string, email: string, password: string) =>
    fetchApi<import('../types').User>('/user/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    }),

  login: (email: string, password: string) =>
    fetchApi<import('../types').User>('/user/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () =>
    fetchApi<{ message: string }>('/user/logout', { method: 'POST' }),

  getMe: () =>
    fetchApi<import('../types').User>('/user/me'),

  getPreferences: () =>
    fetchApi<import('../types').UserPreferences>('/user/preferences'),

  updatePreferences: (prefs: Partial<import('../types').UserPreferences>) =>
    fetchApi<import('../types').UserPreferences>('/user/preferences', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    }),

  recordRead: (articleId: string, dwellTimeSeconds: number) =>
    fetchApi<{ message: string }>('/user/reading-history', {
      method: 'POST',
      body: JSON.stringify({ article_id: articleId, dwell_time_seconds: dwellTimeSeconds }),
    }),

  getReadingHistory: (limit = 50) =>
    fetchApi<{ history: { article_id: string; article_title: string; read_at: string }[] }>(
      `/user/reading-history?limit=${limit}`
    ),

  getAvailableTopics: () =>
    fetchApi<{ topics: string[] }>('/user/available-topics'),
};

// Admin API
export const adminApi = {
  getStats: () =>
    fetchApi<import('../types').AdminStats>('/admin/stats'),

  getSources: () =>
    fetchApi<{ sources: import('../types').Source[] }>('/admin/sources'),

  addSource: (name: string, feedUrl: string, category: string) =>
    fetchApi<import('../types').Source>('/admin/sources', {
      method: 'POST',
      body: JSON.stringify({ name, feed_url: feedUrl, category }),
    }),

  updateSource: (id: string, updates: Partial<import('../types').Source>) =>
    fetchApi<{ message: string }>(`/admin/sources/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  deleteSource: (id: string) =>
    fetchApi<{ message: string }>(`/admin/sources/${id}`, { method: 'DELETE' }),

  crawlSource: (id: string) =>
    fetchApi<{ source_id: string; articles_found: number; articles_new: number; errors: string[] }>(
      `/admin/sources/${id}/crawl`,
      { method: 'POST' }
    ),

  triggerCrawl: () =>
    fetchApi<{ message: string; sources_crawled: number; total_articles_new: number }>(
      '/admin/crawl',
      { method: 'POST' }
    ),

  getArticles: (limit = 50, offset = 0) =>
    fetchApi<{ articles: import('../types').Article[] }>(
      `/admin/articles?limit=${limit}&offset=${offset}`
    ),

  getBreakingCandidates: () =>
    fetchApi<{ stories: import('../types').Story[] }>('/admin/breaking-candidates'),

  setBreaking: (storyId: string, isBreaking: boolean) =>
    fetchApi<{ message: string }>(`/admin/stories/${storyId}/breaking`, {
      method: 'POST',
      body: JSON.stringify({ is_breaking: isBreaking }),
    }),
};
