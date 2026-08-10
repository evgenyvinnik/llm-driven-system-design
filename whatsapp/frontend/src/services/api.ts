/**
 * API Service Module
 *
 * Provides typed HTTP client functions for communicating with the backend.
 * All requests include credentials for session-based authentication.
 */

import { User, Conversation, Message } from '../types';

/** Base URL for all API requests */
const API_BASE = '/api';

/**
 * Generic request wrapper that handles JSON serialization and error handling.
 * @param endpoint - API endpoint path (will be prefixed with /api)
 * @param options - Fetch options (method, body, headers)
 * @returns Parsed JSON response
 * @throws Error with server error message if request fails
 */
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

/**
 * Authentication API endpoints.
 * Handles login, registration, logout, and user discovery.
 */
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

/**
 * Conversation management API endpoints.
 * Handles listing, creating, and managing conversations and groups.
 */
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

/**
 * Message API endpoints.
 * Handles fetching message history and marking messages as read.
 * Note: Message sending happens via WebSocket for real-time delivery.
 */
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

/**
 * Reaction summary returned from the API.
 */
export interface ReactionSummary {
  emoji: string;
  count: number;
  userReacted: boolean;
}

/**
 * Reaction API endpoints.
 * Handles adding, removing, and fetching reactions for messages.
 */
export const reactionsApi = {
  /** All reactions for a conversation, keyed by message ID — one request per thread load. */
  getForConversation: (conversationId: string) =>
    request<{ reactions: Record<string, ReactionSummary[]>; allowedEmojis: string[] }>(
      `/messages/${conversationId}/reactions`
    ),

  get: (conversationId: string, messageId: string) =>
    request<{ reactions: ReactionSummary[]; allowedEmojis: string[] }>(
      `/messages/${conversationId}/${messageId}/reactions`
    ),

  add: (conversationId: string, messageId: string, emoji: string) =>
    request<{ reaction: unknown; reactions: ReactionSummary[] }>(
      `/messages/${conversationId}/${messageId}/reactions`,
      {
        method: 'POST',
        body: JSON.stringify({ emoji }),
      }
    ),

  remove: (conversationId: string, messageId: string, emoji: string) =>
    request<{ success: boolean; reactions: ReactionSummary[] }>(
      `/messages/${conversationId}/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      { method: 'DELETE' }
    ),
};
