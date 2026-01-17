/**
 * Base URL for all API endpoints. Uses relative path to work with Vite proxy in development.
 */
const API_BASE = '/api';

/**
 * Generic HTTP request wrapper that handles authentication and error handling.
 * Automatically attaches JWT token from localStorage if available, sets JSON content type,
 * and parses error responses from the backend.
 *
 * @template T - The expected response type
 * @param endpoint - The API endpoint path (will be prefixed with API_BASE)
 * @param options - Standard fetch RequestInit options
 * @returns Promise resolving to the parsed JSON response
 * @throws Error with message from backend or generic 'Request failed' message
 */
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

/**
 * Centralized API client for the iMessage backend.
 * Provides typed methods for authentication, user management, conversations, and messages.
 * All methods automatically handle authentication via the request wrapper.
 */
export const api = {
  // Auth
  /**
   * Registers a new user account and returns auth credentials.
   * @param data - Registration data including username, email, password, optional displayName and deviceName
   * @returns Promise with user data, device info, and JWT token
   */
  register: (data: {
    username: string;
    email: string;
    password: string;
    displayName?: string;
    deviceName?: string;
  }) => request('/auth/register', { method: 'POST', body: JSON.stringify(data) }),

  /**
   * Authenticates user with username/email and password.
   * @param data - Login credentials and optional device name for session tracking
   * @returns Promise with user data, device info, and JWT token
   */
  login: (data: {
    usernameOrEmail: string;
    password: string;
    deviceName?: string;
  }) => request('/auth/login', { method: 'POST', body: JSON.stringify(data) }),

  /**
   * Logs out the current user and invalidates their session.
   * @returns Promise that resolves when logout is complete
   */
  logout: () => request('/auth/logout', { method: 'POST' }),

  /**
   * Retrieves the current authenticated user's profile and device info.
   * Used to validate session on app load.
   * @returns Promise with current user data and device ID
   */
  getMe: () => request<{ user: import('@/types').User; deviceId: string }>('/auth/me'),

  /**
   * Lists all devices registered to the current user for multi-device support.
   * @returns Promise with array of device objects
   */
  getDevices: () => request<{ devices: import('@/types').Device[] }>('/auth/devices'),

  /**
   * Deactivates a specific device, revoking its access to the account.
   * Used for security when a device is lost or compromised.
   * @param deviceId - The UUID of the device to deactivate
   * @returns Promise that resolves when device is deactivated
   */
  deactivateDevice: (deviceId: string) =>
    request(`/auth/devices/${deviceId}`, { method: 'DELETE' }),

  // Users
  /**
   * Searches for users by username or display name.
   * Used for finding users to start conversations with.
   * @param query - Search string (minimum 2 characters)
   * @returns Promise with array of matching users
   */
  searchUsers: (query: string) =>
    request<{ users: import('@/types').User[] }>(`/users/search?q=${encodeURIComponent(query)}`),

  /**
   * Retrieves a specific user's public profile.
   * @param userId - The UUID of the user to retrieve
   * @returns Promise with user data
   */
  getUser: (userId: string) =>
    request<{ user: import('@/types').User }>(`/users/${userId}`),

  /**
   * Updates the current user's profile information.
   * @param data - Fields to update (displayName and/or avatarUrl)
   * @returns Promise that resolves when update is complete
   */
  updateMe: (data: { displayName?: string; avatarUrl?: string }) =>
    request('/users/me', { method: 'PATCH', body: JSON.stringify(data) }),

  // Conversations
  /**
   * Retrieves all conversations the current user is participating in.
   * Includes last message and unread count for each conversation.
   * @returns Promise with array of conversation objects
   */
  getConversations: () =>
    request<{ conversations: import('@/types').Conversation[] }>('/conversations'),

  /**
   * Retrieves details for a specific conversation including participants.
   * @param id - The UUID of the conversation
   * @returns Promise with conversation data
   */
  getConversation: (id: string) =>
    request<{ conversation: import('@/types').Conversation }>(`/conversations/${id}`),

  /**
   * Creates a direct (1:1) conversation with another user.
   * If a direct conversation already exists, returns the existing one.
   * @param userId - The UUID of the other user
   * @returns Promise with the created or existing conversation
   */
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
