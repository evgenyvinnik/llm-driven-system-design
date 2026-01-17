const API_BASE = '/api';

async function request<T>(
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

// Auth
export const authApi = {
  login: (username: string, password: string) =>
    request<{ user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (username: string, email: string, password: string, displayName?: string) =>
    request<{ user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, displayName }),
    }),

  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),

  getMe: () =>
    request<{ user: import('../types').User }>('/auth/me'),
};

// Channels
export const channelApi = {
  getAll: (params?: { category?: string; limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.category) query.set('category', params.category);
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    return request<{ channels: import('../types').Channel[] }>(
      `/channels?${query.toString()}`
    );
  },

  getLive: (params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    return request<{ channels: import('../types').Channel[] }>(
      `/channels/live?${query.toString()}`
    );
  },

  getByName: (name: string) =>
    request<{ channel: import('../types').Channel }>(`/channels/${name}`),

  follow: (name: string) =>
    request<{ success: boolean }>(`/channels/${name}/follow`, { method: 'POST' }),

  unfollow: (name: string) =>
    request<{ success: boolean }>(`/channels/${name}/follow`, { method: 'DELETE' }),

  subscribe: (name: string, tier: number = 1) =>
    request<{ success: boolean; expiresAt: string }>(`/channels/${name}/subscribe`, {
      method: 'POST',
      body: JSON.stringify({ tier }),
    }),

  update: (name: string, data: { title?: string; description?: string; categoryId?: number }) =>
    request<{ success: boolean }>(`/channels/${name}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
};

// Categories
export const categoryApi = {
  getAll: (params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    return request<{ categories: import('../types').Category[] }>(
      `/categories?${query.toString()}`
    );
  },

  getBySlug: (slug: string) =>
    request<{ category: import('../types').Category }>(`/categories/${slug}`),

  getChannels: (slug: string, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    return request<{ channels: import('../types').Channel[] }>(
      `/categories/${slug}/channels?${query.toString()}`
    );
  },
};

// Streams
export const streamApi = {
  getInfo: (channelId: number) =>
    request<{ stream: import('../types').Stream }>(`/streams/${channelId}`),

  getVODs: (channelId: number, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    return request<{ vods: import('../types').VOD[] }>(
      `/streams/${channelId}/vods?${query.toString()}`
    );
  },

  start: (title: string, categoryId?: number) =>
    request<{ success: boolean; streamId: number }>('/streams/start', {
      method: 'POST',
      body: JSON.stringify({ title, categoryId }),
    }),

  stop: () =>
    request<{ success: boolean }>('/streams/stop', { method: 'POST' }),
};

// Users
export const userApi = {
  getProfile: (username: string) =>
    request<{ user: import('../types').User }>(`/users/${username}`),

  getFollowing: (username: string, params?: { limit?: number; offset?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', params.limit.toString());
    if (params?.offset) query.set('offset', params.offset.toString());
    return request<{ following: import('../types').Channel[] }>(
      `/users/${username}/following?${query.toString()}`
    );
  },

  updateProfile: (data: { displayName?: string; bio?: string; avatarUrl?: string }) =>
    request<{ success: boolean }>('/users/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
};

// Emotes
export const emoteApi = {
  getGlobal: () =>
    request<{ emotes: import('../types').Emote[] }>('/emotes/global'),

  getChannel: (channelId: number) =>
    request<{ emotes: import('../types').Emote[] }>(`/emotes/channel/${channelId}`),

  getAvailable: (channelId: number) =>
    request<{ emotes: import('../types').Emote[] }>(`/emotes/available/${channelId}`),
};
