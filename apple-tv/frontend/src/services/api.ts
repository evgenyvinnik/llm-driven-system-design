const API_BASE = '/api';

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

// Auth API
export const authApi = {
  login: (email: string, password: string) =>
    fetchApi('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, name: string) =>
    fetchApi('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),

  logout: () =>
    fetchApi('/auth/logout', { method: 'POST' }),

  getMe: () =>
    fetchApi<{ user: import('../types').User; profiles: import('../types').Profile[] }>('/auth/me'),

  selectProfile: (profileId: string) =>
    fetchApi(`/auth/profile/${profileId}/select`, { method: 'POST' }),

  createProfile: (name: string, isKids: boolean) =>
    fetchApi('/auth/profiles', {
      method: 'POST',
      body: JSON.stringify({ name, isKids }),
    }),

  deleteProfile: (profileId: string) =>
    fetchApi(`/auth/profiles/${profileId}`, { method: 'DELETE' }),
};

// Content API
export const contentApi = {
  getAll: (params?: { type?: string; genre?: string; search?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.type) searchParams.set('type', params.type);
    if (params?.genre) searchParams.set('genre', params.genre);
    if (params?.search) searchParams.set('search', params.search);
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());
    return fetchApi<import('../types').Content[]>(`/content?${searchParams.toString()}`);
  },

  getFeatured: () =>
    fetchApi<import('../types').Content[]>('/content/featured'),

  getById: (id: string) =>
    fetchApi<import('../types').Content>(`/content/${id}`),

  getSeasons: (id: string) =>
    fetchApi<Record<number, import('../types').Episode[]>>(`/content/${id}/seasons`),

  getGenres: () =>
    fetchApi<string[]>('/content/meta/genres'),

  incrementView: (id: string) =>
    fetchApi(`/content/${id}/view`, { method: 'POST' }),
};

// Streaming API
export const streamingApi = {
  getPlaybackInfo: (contentId: string) =>
    fetchApi<import('../types').PlaybackInfo>(`/stream/${contentId}/playback`),
};

// Watch Progress API
export const watchProgressApi = {
  getProgress: () =>
    fetchApi<import('../types').WatchProgress[]>('/watch/progress'),

  getContinueWatching: () =>
    fetchApi<import('../types').ContinueWatching[]>('/watch/continue'),

  updateProgress: (contentId: string, position: number, duration: number) =>
    fetchApi(`/watch/progress/${contentId}`, {
      method: 'POST',
      body: JSON.stringify({ position, duration }),
    }),

  getContentProgress: (contentId: string) =>
    fetchApi<import('../types').WatchProgress>(`/watch/progress/${contentId}`),

  getHistory: (params?: { limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());
    return fetchApi(`/watch/history?${searchParams.toString()}`);
  },

  clearHistory: () =>
    fetchApi('/watch/history', { method: 'DELETE' }),
};

// Watchlist API
export const watchlistApi = {
  getAll: () =>
    fetchApi<import('../types').WatchlistItem[]>('/watchlist'),

  add: (contentId: string) =>
    fetchApi(`/watchlist/${contentId}`, { method: 'POST' }),

  remove: (contentId: string) =>
    fetchApi(`/watchlist/${contentId}`, { method: 'DELETE' }),

  check: (contentId: string) =>
    fetchApi<{ inWatchlist: boolean }>(`/watchlist/check/${contentId}`),
};

// Subscription API
export const subscriptionApi = {
  getStatus: () =>
    fetchApi<{ tier: string; expiresAt: string | null; isActive: boolean }>('/subscription/status'),

  getPlans: () =>
    fetchApi<import('../types').SubscriptionPlan[]>('/subscription/plans'),

  subscribe: (planId: string) =>
    fetchApi<{ success: boolean; tier: string; expiresAt: string }>('/subscription/subscribe', {
      method: 'POST',
      body: JSON.stringify({ planId }),
    }),

  cancel: () =>
    fetchApi('/subscription/cancel', { method: 'POST' }),
};

// Recommendations API
export const recommendationsApi = {
  getAll: (limit?: number) => {
    const params = limit ? `?limit=${limit}` : '';
    return fetchApi<import('../types').RecommendationSection[]>(`/recommendations${params}`);
  },

  getBecauseYouWatched: (contentId: string, limit?: number) => {
    const params = limit ? `?limit=${limit}` : '';
    return fetchApi<import('../types').Content[]>(`/recommendations/because-you-watched/${contentId}${params}`);
  },

  getTrending: (limit?: number) => {
    const params = limit ? `?limit=${limit}` : '';
    return fetchApi<import('../types').Content[]>(`/recommendations/trending${params}`);
  },

  getNewReleases: (limit?: number) => {
    const params = limit ? `?limit=${limit}` : '';
    return fetchApi<import('../types').Content[]>(`/recommendations/new-releases${params}`);
  },

  getByGenre: (genre: string, limit?: number) => {
    const params = limit ? `?limit=${limit}` : '';
    return fetchApi<import('../types').Content[]>(`/recommendations/genre/${genre}${params}`);
  },

  rate: (contentId: string, rating: number) =>
    fetchApi(`/recommendations/rate/${contentId}`, {
      method: 'POST',
      body: JSON.stringify({ rating }),
    }),

  getRating: (contentId: string) =>
    fetchApi<{ rating: number | null }>(`/recommendations/rating/${contentId}`),
};

// Admin API
export const adminApi = {
  getStats: () =>
    fetchApi('/admin/stats'),

  getUsers: (params?: { limit?: number; offset?: number; search?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());
    if (params?.search) searchParams.set('search', params.search);
    return fetchApi(`/admin/users?${searchParams.toString()}`);
  },

  getContent: (params?: { limit?: number; offset?: number; status?: string; type?: string; search?: string }) => {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());
    if (params?.status) searchParams.set('status', params.status);
    if (params?.type) searchParams.set('type', params.type);
    if (params?.search) searchParams.set('search', params.search);
    return fetchApi(`/admin/content?${searchParams.toString()}`);
  },

  createContent: (data: Partial<import('../types').Content>) =>
    fetchApi('/admin/content', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateContent: (id: string, data: Partial<import('../types').Content>) =>
    fetchApi(`/admin/content/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteContent: (id: string) =>
    fetchApi(`/admin/content/${id}`, { method: 'DELETE' }),

  toggleFeatured: (id: string) =>
    fetchApi(`/admin/content/${id}/feature`, { method: 'POST' }),

  getViewAnalytics: (days?: number) => {
    const params = days ? `?days=${days}` : '';
    return fetchApi(`/admin/analytics/views${params}`);
  },
};
