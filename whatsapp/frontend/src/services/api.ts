import { User, Conversation, Message } from '../types';

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

// Auth API
export const authApi = {
  login: (username: string, password: string) =>
    request<{ user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (username: string, displayName: string, password: string) =>
    request<{ user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, displayName, password }),
    }),

  logout: () =>
    request<{ success: boolean }>('/auth/logout', {
      method: 'POST',
    }),

  me: () => request<{ user: User }>('/auth/me'),

  searchUsers: (query: string) =>
    request<{ users: User[] }>(`/auth/search?q=${encodeURIComponent(query)}`),

  getUser: (id: string) =>
    request<{ user: User & { presence: { status: string; last_seen: number } } }>(
      `/auth/${id}`
    ),
};

// Conversations API
export const conversationsApi = {
  list: () => request<{ conversations: Conversation[] }>('/conversations'),

  get: (id: string) => request<{ conversation: Conversation }>(`/conversations/${id}`),

  createDirect: (userId: string) =>
    request<{ conversation: Conversation }>('/conversations/direct', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  createGroup: (name: string, memberIds: string[]) =>
    request<{ conversation: Conversation }>('/conversations/group', {
      method: 'POST',
      body: JSON.stringify({ name, memberIds }),
    }),

  addMember: (conversationId: string, userId: string) =>
    request<{ conversation: Conversation }>(`/conversations/${conversationId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  removeMember: (conversationId: string, userId: string) =>
    request<{ success: boolean }>(
      `/conversations/${conversationId}/members/${userId}`,
      { method: 'DELETE' }
    ),
};

// Messages API
export const messagesApi = {
  list: (conversationId: string, limit?: number, beforeId?: string) => {
    const params = new URLSearchParams();
    if (limit) params.set('limit', limit.toString());
    if (beforeId) params.set('before', beforeId);
    const query = params.toString() ? `?${params.toString()}` : '';
    return request<{ messages: Message[] }>(`/messages/${conversationId}${query}`);
  },

  markRead: (conversationId: string) =>
    request<{ messageIds: string[] }>(`/messages/${conversationId}/read`, {
      method: 'POST',
    }),
};
