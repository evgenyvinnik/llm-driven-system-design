/**
 * API client module for the News Aggregator frontend.
 * Provides typed API methods for feed, user, and admin operations.
 * All methods automatically include credentials for session authentication.
 * @module services/api
 */

/** Base URL for API endpoints */
const API_BASE = '/api/v1';

/**
 * Generic fetch wrapper with error handling.
 * Automatically includes credentials and JSON content type.
 * @param endpoint - API endpoint path (without base URL)
 * @param options - Fetch options (method, body, headers, etc.)
 * @returns Parsed JSON response typed as T
 * @throws Error with message from API or HTTP status
 */
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

/**
 * Feed API client.
 * Provides methods for fetching news feeds, stories, and search.
 */
export const feedApi = {
  /**
   * Get personalized news feed.
   * @param cursor - Pagination cursor from previous response
   * @param limit - Number of stories per page (default: 20)
   * @returns Paginated feed response with stories
   */
  getFeed: (cursor?: string, limit = 20) =>
    fetchApi<{ stories: import('../types').Story[]; next_cursor: string | null; has_more: boolean }>(
      `/feed?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) })}`
    ),

  /**
   * Get feed filtered by topic.
   * @param topic - Topic name to filter by
   * @param cursor - Pagination cursor
   * @param limit - Number of stories per page
   * @returns Paginated feed response for the topic
   */
  getTopicFeed: (topic: string, cursor?: string, limit = 20) =>
    fetchApi<{ stories: import('../types').Story[]; next_cursor: string | null; has_more: boolean }>(
      `/feed/topic/${encodeURIComponent(topic)}?${new URLSearchParams({ ...(cursor ? { cursor } : {}), limit: String(limit) })}`
    ),

  /**
   * Get breaking news stories.
   * @returns Array of breaking/high-velocity stories
   */
  getBreaking: () =>
    fetchApi<{ stories: import('../types').Story[] }>('/breaking'),

  /**
   * Get trending stories.
   * @returns Array of stories with most coverage
   */
  getTrending: () =>
    fetchApi<{ stories: import('../types').Story[] }>('/trending'),

  /**
   * Get a single story with all its articles.
   * @param id - Story UUID
   * @returns Full story details with articles
   */
  getStory: (id: string) =>
    fetchApi<import('../types').Story>(`/stories/${id}`),

  /**
   * Get articles for a story.
   * @param id - Story UUID
   * @param limit - Maximum articles to return
   * @returns Array of articles belonging to the story
   */
  getStoryArticles: (id: string, limit = 20) =>
    fetchApi<{ articles: import('../types').Article[] }>(`/stories/${id}/articles?limit=${limit}`),

  /**
   * Search articles by query.
   * @param query - Search query string
   * @param options - Optional filters (topics, date range, limit)
   * @returns Array of matching articles
   */
  search: (query: string, options?: { topics?: string[]; dateFrom?: string; dateTo?: string; limit?: number }) => {
    const params = new URLSearchParams({ q: query });
    if (options?.topics?.length) params.set('topics', options.topics.join(','));
    if (options?.dateFrom) params.set('date_from', options.dateFrom);
    if (options?.dateTo) params.set('date_to', options.dateTo);
    if (options?.limit) params.set('limit', String(options.limit));
    return fetchApi<{ articles: import('../types').Article[] }>(`/search?${params}`);
  },

  /**
   * Get available topics with story counts.
   * @returns Array of topics sorted by popularity
   */
  getTopics: () =>
    fetchApi<{ topics: import('../types').Topic[] }>('/topics'),
};

/**
 * User API client.
 * Provides methods for authentication and preference management.
 */
export const userApi = {
  /**
   * Register a new user account.
   * @param username - Display name
   * @param email - Email address
   * @param password - Password (min 6 characters)
   * @returns Created user profile
   */
  register: (username: string, email: string, password: string) =>
    fetchApi<import('../types').User>('/user/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    }),

  /**
   * Login with email and password.
   * @param email - User's email address
   * @param password - User's password
   * @returns User profile on success
   */
  login: (email: string, password: string) =>
    fetchApi<import('../types').User>('/user/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  /**
   * Logout and destroy session.
   * @returns Success message
   */
  logout: () =>
    fetchApi<{ message: string }>('/user/logout', { method: 'POST' }),

  /**
   * Get current authenticated user.
   * @returns User profile or throws if not authenticated
   */
  getMe: () =>
    fetchApi<import('../types').User>('/user/me'),

  /**
   * Get user's preferences.
   * @returns User preferences
   */
  getPreferences: () =>
    fetchApi<import('../types').UserPreferences>('/user/preferences'),

  /**
   * Update user's preferences.
   * @param prefs - Partial preferences to update
   * @returns Updated complete preferences
   */
  updatePreferences: (prefs: Partial<import('../types').UserPreferences>) =>
    fetchApi<import('../types').UserPreferences>('/user/preferences', {
      method: 'PUT',
      body: JSON.stringify(prefs),
    }),

  /**
   * Record that user read an article.
   * Used for learning implicit preferences.
   * @param articleId - Article UUID that was read
   * @param dwellTimeSeconds - Time spent reading
   * @returns Success message
   */
  recordRead: (articleId: string, dwellTimeSeconds: number) =>
    fetchApi<{ message: string }>('/user/reading-history', {
      method: 'POST',
      body: JSON.stringify({ article_id: articleId, dwell_time_seconds: dwellTimeSeconds }),
    }),

  /**
   * Get user's reading history.
   * @param limit - Maximum entries to return
   * @returns Array of reading history entries
   */
  getReadingHistory: (limit = 50) =>
    fetchApi<{ history: { article_id: string; article_title: string; read_at: string }[] }>(
      `/user/reading-history?limit=${limit}`
    ),

  /**
   * Get available topics for preference selection.
   * @returns Array of topic names
   */
  getAvailableTopics: () =>
    fetchApi<{ topics: string[] }>('/user/available-topics'),
};

/**
 * Admin API client.
 * Provides methods for system administration (requires admin role).
 */
export const adminApi = {
  /**
   * Get admin dashboard statistics.
   * @returns System statistics
   */
  getStats: () =>
    fetchApi<import('../types').AdminStats>('/admin/stats'),

  /**
   * Get all news sources.
   * @returns Array of source configurations
   */
  getSources: () =>
    fetchApi<{ sources: import('../types').Source[] }>('/admin/sources'),

  /**
   * Add a new news source.
   * @param name - Human-readable source name
   * @param feedUrl - RSS/Atom feed URL
   * @param category - Default category
   * @returns Created source
   */
  addSource: (name: string, feedUrl: string, category: string) =>
    fetchApi<import('../types').Source>('/admin/sources', {
      method: 'POST',
      body: JSON.stringify({ name, feed_url: feedUrl, category }),
    }),

  /**
   * Update a news source.
   * @param id - Source UUID
   * @param updates - Partial source data to update
   * @returns Success message
   */
  updateSource: (id: string, updates: Partial<import('../types').Source>) =>
    fetchApi<{ message: string }>(`/admin/sources/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  /**
   * Delete a news source.
   * @param id - Source UUID
   * @returns Success message
   */
  deleteSource: (id: string) =>
    fetchApi<{ message: string }>(`/admin/sources/${id}`, { method: 'DELETE' }),

  /**
   * Manually trigger crawl for a source.
   * @param id - Source UUID
   * @returns Crawl results
   */
  crawlSource: (id: string) =>
    fetchApi<{ source_id: string; articles_found: number; articles_new: number; errors: string[] }>(
      `/admin/sources/${id}/crawl`,
      { method: 'POST' }
    ),

  /**
   * Trigger full crawl of all due sources.
   * @returns Crawl summary
   */
  triggerCrawl: () =>
    fetchApi<{ message: string; sources_crawled: number; total_articles_new: number }>(
      '/admin/crawl',
      { method: 'POST' }
    ),

  /**
   * Get recent articles for admin review.
   * @param limit - Articles per page
   * @param offset - Pagination offset
   * @returns Array of articles
   */
  getArticles: (limit = 50, offset = 0) =>
    fetchApi<{ articles: import('../types').Article[] }>(
      `/admin/articles?limit=${limit}&offset=${offset}`
    ),

  /**
   * Get stories that may be breaking news.
   * @returns Array of high-velocity stories
   */
  getBreakingCandidates: () =>
    fetchApi<{ stories: import('../types').Story[] }>('/admin/breaking-candidates'),

  /**
   * Set story breaking news status.
   * @param storyId - Story UUID
   * @param isBreaking - Whether to mark as breaking
   * @returns Success message
   */
  setBreaking: (storyId: string, isBreaking: boolean) =>
    fetchApi<{ message: string }>(`/admin/stories/${storyId}/breaking`, {
      method: 'POST',
      body: JSON.stringify({ is_breaking: isBreaking }),
    }),
};
