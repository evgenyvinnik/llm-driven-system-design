const API_BASE = '/api';

async function request<T>(
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
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

// Auth API
export const authApi = {
  login: (email: string, password: string) =>
    request<{ message: string; user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (email: string, password: string, username: string, display_name?: string) =>
    request<{ message: string; user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, username, display_name }),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<import('../types').User>('/auth/me'),

  updateProfile: (data: { display_name?: string; avatar_url?: string }) =>
    request<import('../types').User>('/auth/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
};

// Workspace API
export const workspaceApi = {
  list: () =>
    request<import('../types').Workspace[]>('/workspaces'),

  create: (name: string, domain: string) =>
    request<import('../types').Workspace>('/workspaces', {
      method: 'POST',
      body: JSON.stringify({ name, domain }),
    }),

  get: (id: string) =>
    request<import('../types').Workspace>(`/workspaces/${id}`),

  getByDomain: (domain: string) =>
    request<import('../types').Workspace>(`/workspaces/domain/${domain}`),

  join: (id: string) =>
    request<{ message: string }>(`/workspaces/${id}/join`, { method: 'POST' }),

  select: (id: string) =>
    request<{ message: string; workspaceId: string }>(`/workspaces/${id}/select`, { method: 'POST' }),

  getMembers: (id: string) =>
    request<import('../types').WorkspaceMember[]>(`/workspaces/${id}/members`),
};

// Channel API
export const channelApi = {
  list: () =>
    request<import('../types').Channel[]>('/channels'),

  create: (name: string, topic?: string, description?: string, is_private?: boolean) =>
    request<import('../types').Channel>('/channels', {
      method: 'POST',
      body: JSON.stringify({ name, topic, description, is_private }),
    }),

  get: (id: string) =>
    request<import('../types').Channel>(`/channels/${id}`),

  update: (id: string, data: { topic?: string; description?: string }) =>
    request<import('../types').Channel>(`/channels/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  join: (id: string) =>
    request<{ message: string }>(`/channels/${id}/join`, { method: 'POST' }),

  leave: (id: string) =>
    request<{ message: string }>(`/channels/${id}/leave`, { method: 'POST' }),

  getMembers: (id: string) =>
    request<import('../types').WorkspaceMember[]>(`/channels/${id}/members`),

  markRead: (id: string) =>
    request<{ message: string }>(`/channels/${id}/read`, { method: 'POST' }),
};

// DM API
export const dmApi = {
  list: () =>
    request<import('../types').DMChannel[]>('/dms'),

  create: (user_ids: string[]) =>
    request<import('../types').DMChannel>('/dms', {
      method: 'POST',
      body: JSON.stringify({ user_ids }),
    }),

  get: (id: string) =>
    request<import('../types').DMChannel>(`/dms/${id}`),
};

// Message API
export const messageApi = {
  list: (channelId: string, before?: number, limit?: number) => {
    const params = new URLSearchParams();
    if (before) params.set('before', String(before));
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return request<import('../types').Message[]>(`/messages/channel/${channelId}${query ? `?${query}` : ''}`);
  },

  send: (channelId: string, content: string, thread_ts?: number) =>
    request<import('../types').Message>(`/messages/channel/${channelId}`, {
      method: 'POST',
      body: JSON.stringify({ content, thread_ts }),
    }),

  update: (messageId: number, content: string) =>
    request<import('../types').Message>(`/messages/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),

  delete: (messageId: number) =>
    request<{ message: string }>(`/messages/${messageId}`, { method: 'DELETE' }),

  getThread: (messageId: number) =>
    request<import('../types').Thread>(`/messages/${messageId}/thread`),

  addReaction: (messageId: number, emoji: string) =>
    request<{ message: string }>(`/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ emoji }),
    }),

  removeReaction: (messageId: number, emoji: string) =>
    request<{ message: string }>(`/messages/${messageId}/reactions/${emoji}`, { method: 'DELETE' }),
};

// Search API
export const searchApi = {
  search: (query: string, filters?: { channel_id?: string; user_id?: string; from_date?: string; to_date?: string }) => {
    const params = new URLSearchParams({ q: query });
    if (filters?.channel_id) params.set('channel_id', filters.channel_id);
    if (filters?.user_id) params.set('user_id', filters.user_id);
    if (filters?.from_date) params.set('from_date', filters.from_date);
    if (filters?.to_date) params.set('to_date', filters.to_date);
    return request<import('../types').SearchResult[]>(`/search?${params.toString()}`);
  },
};
