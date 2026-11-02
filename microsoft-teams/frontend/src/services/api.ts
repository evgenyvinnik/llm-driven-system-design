const API_BASE = '/api';

/**
 * An HTTP error response. Network failures surface as a plain TypeError from
 * fetch instead, which is how callers tell "the server said no" (don't retry)
 * from "the request may not have arrived" (safe to retry with the same id).
 */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    credentials: 'include',
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Request failed: ${res.status}`);
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
  me: () => request<{ user: { id: string; username: string; role: string } }>('/auth/me'),
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
  create: (orgId: string, name: string, description?: string, isPrivate?: boolean) =>
    request<{ team: import('../types').Team; defaultChannel: import('../types').Channel }>(
      '/teams',
      {
        method: 'POST',
        body: JSON.stringify({ orgId, name, description, isPrivate }),
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
  /** Leave (your own id) or remove a member; 409 if they are the last owner. */
  removeMember: (teamId: string, userId: string) =>
    request(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),
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
  /** Leave or remove someone from a private channel. */
  removeMember: (channelId: string, userId: string) =>
    request(`/channels/${channelId}/members/${userId}`, { method: 'DELETE' }),
  markRead: (channelId: string) =>
    request(`/channels/${channelId}/read`, { method: 'POST' }),
};

/** Message API client for listing, sending, editing, deleting, and thread retrieval. */
export const messageApi = {
  /** One page, newest first. `beforeId` is the oldest message already loaded. */
  list: (channelId: string, beforeId?: string, limit?: number) => {
    let url = `/messages?channelId=${channelId}`;
    if (beforeId) url += `&before=${beforeId}`;
    if (limit) url += `&limit=${limit}`;
    return request<{ messages: import('../types').Message[]; hasMore: boolean }>(url);
  },
  getThread: (messageId: string) =>
    request<{ messages: import('../types').Message[] }>(`/messages/${messageId}/thread`),
  /** `id` is a client-generated UUID: re-sending it after a lost response can't duplicate the message. */
  send: (input: {
    id: string;
    channelId: string;
    content: string;
    parentMessageId?: string;
    fileIds?: string[];
  }) =>
    request<{ message: import('../types').Message }>('/messages', {
      method: 'POST',
      body: JSON.stringify(input),
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
      throw new ApiError(res.status, data.error || 'Upload failed');
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
