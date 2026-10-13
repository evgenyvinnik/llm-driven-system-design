const API_BASE = '/api';

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

/** Authentication API client for login, register, logout, and session check. */
export const authApi = {
  login: (username: string, password: string) =>
    request<{ user: { id: string; username: string; role: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  register: (username: string, email: string, password: string) =>
    request<{ user: { id: string; username: string; role: string } }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    }),
  logout: () => request('/auth/logout', { method: 'POST' }),
  me: () =>
    request<{ user: { id: string; username: string; displayName?: string; role: string } }>(
      '/auth/me',
    ),
};

/** Organization API client for listing, creating, and managing org membership. */
export const orgApi = {
  list: () => request<{ organizations: import('../types').Organization[] }>('/organizations'),
  create: (name: string, description?: string) =>
    request<{ organization: import('../types').Organization }>('/organizations', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }),
  get: (orgId: string) =>
    request<{ organization: import('../types').Organization }>(`/organizations/${orgId}`),
  getMembers: (orgId: string) =>
    request<{ members: import('../types').OrgMember[] }>(`/organizations/${orgId}/members`),
  addMember: (orgId: string, userId: string) =>
    request(`/organizations/${orgId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
};

/** Team API client for listing, creating, and managing team membership within organizations. */
export const teamApi = {
  list: (orgId: string) =>
    request<{ teams: import('../types').Team[] }>(`/teams?orgId=${orgId}`),
  create: (orgId: string, name: string, description?: string) =>
    request<{ team: import('../types').Team; defaultChannel: import('../types').Channel }>(
      '/teams',
      {
        method: 'POST',
        body: JSON.stringify({ orgId, name, description }),
      },
    ),
  get: (teamId: string) =>
    request<{ team: import('../types').Team }>(`/teams/${teamId}`),
  getMembers: (teamId: string) =>
    request<{ members: import('../types').TeamMember[] }>(`/teams/${teamId}/members`),
  addMember: (teamId: string, userId: string) =>
    request(`/teams/${teamId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
};

/** Channel API client for listing, creating, managing members, and marking as read. */
export const channelApi = {
  list: (teamId: string) =>
    request<{ channels: import('../types').Channel[] }>(`/channels?teamId=${teamId}`),
  create: (teamId: string, name: string, description?: string, isPrivate?: boolean) =>
    request<{ channel: import('../types').Channel }>('/channels', {
      method: 'POST',
      body: JSON.stringify({ teamId, name, description, isPrivate }),
    }),
  get: (channelId: string) =>
    request<{ channel: import('../types').Channel }>(`/channels/${channelId}`),
  getMembers: (channelId: string) =>
    request<{ members: import('../types').ChannelMember[] }>(`/channels/${channelId}/members`),
  addMember: (channelId: string, userId: string) =>
    request(`/channels/${channelId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  markRead: (channelId: string) =>
    request(`/channels/${channelId}/read`, { method: 'POST' }),
};

/** Message API client for listing, sending, editing, deleting, and thread retrieval. */
export const messageApi = {
  /** Newest page when `beforeSeq` is omitted; otherwise the page of messages older than it. */
  list: (channelId: string, beforeSeq?: number, limit?: number) => {
    const params = new URLSearchParams({ channelId });
    if (beforeSeq) params.set('before', String(beforeSeq));
    if (limit) params.set('limit', String(limit));
    return request<import('../types').MessagePage>(`/messages?${params}`);
  },
  getThread: (messageId: string) =>
    request<{ messages: import('../types').Message[] }>(`/messages/${messageId}/thread`),
  /** `clientMessageId` must be reused on every retry of the same message. */
  send: (channelId: string, content: string, clientMessageId: string, parentMessageId?: string) =>
    request<{ message: import('../types').Message }>('/messages', {
      method: 'POST',
      body: JSON.stringify({ channelId, content, clientMessageId, parentMessageId }),
    }),
  edit: (messageId: string, content: string) =>
    request<{ message: import('../types').Message }>(`/messages/${messageId}`, {
      method: 'PUT',
      body: JSON.stringify({ content }),
    }),
  delete: (messageId: string) =>
    request(`/messages/${messageId}`, { method: 'DELETE' }),
};

/** Reaction API client for adding and removing emoji reactions on messages. */
export const reactionApi = {
  add: (messageId: string, emoji: string) =>
    request('/reactions', {
      method: 'POST',
      body: JSON.stringify({ messageId, emoji }),
    }),
  remove: (messageId: string, emoji: string) =>
    request('/reactions', {
      method: 'DELETE',
      body: JSON.stringify({ messageId, emoji }),
    }),
};

/** File API client for uploading, downloading, and listing channel file attachments. */
export const fileApi = {
  upload: async (channelId: string, file: File, messageId?: string) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('channelId', channelId);
    if (messageId) formData.append('messageId', messageId);

    const res = await fetch(`${API_BASE}/files`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Upload failed');
    }

    return res.json() as Promise<{ file: import('../types').FileAttachment }>;
  },
  download: (fileId: string) =>
    request<{ url: string; file: import('../types').FileAttachment }>(`/files/${fileId}/download`),
  list: (channelId: string) =>
    request<{ files: import('../types').FileAttachment[] }>(`/files?channelId=${channelId}`),
};

/** Presence API client for heartbeat updates and channel member presence checks. */
export const presenceApi = {
  heartbeat: () => request('/presence/heartbeat', { method: 'POST' }),
  getChannelPresence: (channelId: string) =>
    request<{ members: import('../types').ChannelMember[] }>(`/presence/channel/${channelId}`),
};

/** User API client for searching and fetching user profiles. */
export const userApi = {
  search: (q: string) =>
    request<{ users: import('../types').User[] }>(`/users/search?q=${encodeURIComponent(q)}`),
  get: (userId: string) =>
    request<{ user: import('../types').User }>(`/users/${userId}`),
};
