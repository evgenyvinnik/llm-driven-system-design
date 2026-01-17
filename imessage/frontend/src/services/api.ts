const API_BASE = '/api';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('token');

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export const api = {
  // Auth
  register: (data: {
    username: string;
    email: string;
    password: string;
    displayName?: string;
    deviceName?: string;
  }) => request('/auth/register', { method: 'POST', body: JSON.stringify(data) }),

  login: (data: {
    usernameOrEmail: string;
    password: string;
    deviceName?: string;
  }) => request('/auth/login', { method: 'POST', body: JSON.stringify(data) }),

  logout: () => request('/auth/logout', { method: 'POST' }),

  getMe: () => request<{ user: import('@/types').User; deviceId: string }>('/auth/me'),

  getDevices: () => request<{ devices: import('@/types').Device[] }>('/auth/devices'),

  deactivateDevice: (deviceId: string) =>
    request(`/auth/devices/${deviceId}`, { method: 'DELETE' }),

  // Users
  searchUsers: (query: string) =>
    request<{ users: import('@/types').User[] }>(`/users/search?q=${encodeURIComponent(query)}`),

  getUser: (userId: string) =>
    request<{ user: import('@/types').User }>(`/users/${userId}`),

  updateMe: (data: { displayName?: string; avatarUrl?: string }) =>
    request('/users/me', { method: 'PATCH', body: JSON.stringify(data) }),

  // Conversations
  getConversations: () =>
    request<{ conversations: import('@/types').Conversation[] }>('/conversations'),

  getConversation: (id: string) =>
    request<{ conversation: import('@/types').Conversation }>(`/conversations/${id}`),

  createDirectConversation: (userId: string) =>
    request<{ conversation: import('@/types').Conversation }>('/conversations/direct', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  createGroupConversation: (name: string, participantIds: string[]) =>
    request<{ conversation: import('@/types').Conversation }>('/conversations/group', {
      method: 'POST',
      body: JSON.stringify({ name, participantIds }),
    }),

  addParticipant: (conversationId: string, userId: string) =>
    request(`/conversations/${conversationId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  removeParticipant: (conversationId: string, userId: string) =>
    request(`/conversations/${conversationId}/participants/${userId}`, { method: 'DELETE' }),

  leaveConversation: (conversationId: string) =>
    request(`/conversations/${conversationId}/leave`, { method: 'DELETE' }),

  // Messages
  getMessages: (conversationId: string, options?: { limit?: number; before?: string; after?: string }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.before) params.set('before', options.before);
    if (options?.after) params.set('after', options.after);
    const query = params.toString();
    return request<{ messages: import('@/types').Message[] }>(
      `/messages/conversation/${conversationId}${query ? `?${query}` : ''}`
    );
  },

  sendMessage: (conversationId: string, content: string, options?: { contentType?: string; replyToId?: string }) =>
    request<{ message: import('@/types').Message }>(`/messages/conversation/${conversationId}`, {
      method: 'POST',
      body: JSON.stringify({ content, ...options }),
    }),

  editMessage: (messageId: string, content: string) =>
    request(`/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),

  deleteMessage: (messageId: string) =>
    request(`/messages/${messageId}`, { method: 'DELETE' }),

  addReaction: (messageId: string, reaction: string) =>
    request(`/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ reaction }),
    }),

  removeReaction: (messageId: string, reaction: string) =>
    request(`/messages/${messageId}/reactions/${encodeURIComponent(reaction)}`, { method: 'DELETE' }),

  markAsRead: (conversationId: string, messageId: string) =>
    request(`/messages/conversation/${conversationId}/read`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),

  getReadReceipts: (conversationId: string) =>
    request<{ receipts: import('@/types').ReadReceipt[] }>(
      `/messages/conversation/${conversationId}/read-receipts`
    ),
};
