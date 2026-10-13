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
    installId?: string;
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
    installId?: string;
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

  /**
   * Creates a group conversation with multiple participants.
   * @param name - Display name for the group
   * @param participantIds - Array of user UUIDs to include in the group
   * @returns Promise with the created group conversation
   */
  createGroupConversation: (name: string, participantIds: string[]) =>
    request<{ conversation: import('@/types').Conversation }>('/conversations/group', {
      method: 'POST',
      body: JSON.stringify({ name, participantIds }),
    }),

  /**
   * Adds a new participant to an existing group conversation.
   * Requires admin role in the conversation.
   * @param conversationId - The UUID of the conversation
   * @param userId - The UUID of the user to add
   * @returns Promise that resolves when participant is added
   */
  addParticipant: (conversationId: string, userId: string) =>
    request(`/conversations/${conversationId}/participants`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),

  /**
   * Removes a participant from a group conversation.
   * Requires admin role in the conversation.
   * @param conversationId - The UUID of the conversation
   * @param userId - The UUID of the user to remove
   * @returns Promise that resolves when participant is removed
   */
  removeParticipant: (conversationId: string, userId: string) =>
    request(`/conversations/${conversationId}/participants/${userId}`, { method: 'DELETE' }),

  /**
   * Allows current user to leave a group conversation.
   * @param conversationId - The UUID of the conversation to leave
   * @returns Promise that resolves when user has left
   */
  leaveConversation: (conversationId: string) =>
    request(`/conversations/${conversationId}/leave`, { method: 'DELETE' }),

  // Messages
  /**
   * Retrieves messages for a conversation, oldest first, with keyset
   * pagination on the conversation sequence number.
   * @param conversationId - The UUID of the conversation
   * @param options - limit (default 50); beforeSeq for older history; afterSeq to fill a gap
   * @returns Promise with array of messages
   */
  getMessages: (conversationId: string, options?: { limit?: number; beforeSeq?: number; afterSeq?: number }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.beforeSeq !== undefined) params.set('before_seq', options.beforeSeq.toString());
    if (options?.afterSeq !== undefined) params.set('after_seq', options.afterSeq.toString());
    const query = params.toString();
    return request<{ messages: import('@/types').Message[] }>(
      `/messages/conversation/${conversationId}${query ? `?${query}` : ''}`
    );
  },

  /**
   * Sends a new message to a conversation via REST API.
   * For real-time messaging, prefer using WebSocket sendMessage instead.
   * @param conversationId - The UUID of the conversation
   * @param content - The message text content
   * @param options - Optional contentType and replyToId for threaded replies
   * @returns Promise with the created message
   */
  sendMessage: (conversationId: string, content: string, options?: { contentType?: string; replyToId?: string }) =>
    request<{ message: import('@/types').Message }>(`/messages/conversation/${conversationId}`, {
      method: 'POST',
      body: JSON.stringify({ content, ...options }),
    }),

  /**
   * Edits an existing message content. Only the sender can edit their messages.
   * @param messageId - The UUID of the message to edit
   * @param content - The new message content
   * @returns Promise that resolves when message is updated
   */
  editMessage: (messageId: string, content: string) =>
    request(`/messages/${messageId}`, {
      method: 'PATCH',
      body: JSON.stringify({ content }),
    }),

  /**
   * Deletes a message. Only the sender can delete their messages.
   * @param messageId - The UUID of the message to delete
   * @returns Promise that resolves when message is deleted
   */
  deleteMessage: (messageId: string) =>
    request(`/messages/${messageId}`, { method: 'DELETE' }),

  /**
   * Adds an emoji reaction to a message.
   * @param messageId - The UUID of the message to react to
   * @param reaction - The emoji reaction string
   * @returns Promise that resolves when reaction is added
   */
  addReaction: (messageId: string, reaction: string) =>
    request(`/messages/${messageId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ reaction }),
    }),

  /**
   * Removes an emoji reaction from a message.
   * @param messageId - The UUID of the message
   * @param reaction - The emoji reaction to remove
   * @returns Promise that resolves when reaction is removed
   */
  removeReaction: (messageId: string, reaction: string) =>
    request(`/messages/${messageId}/reactions/${encodeURIComponent(reaction)}`, { method: 'DELETE' }),

  /**
   * Marks messages in a conversation as read up to a specific message.
   * Updates read receipts for other participants to see.
   * @param conversationId - The UUID of the conversation
   * @param messageId - The UUID of the last read message
   * @returns Promise that resolves when read status is updated
   */
  markAsRead: (conversationId: string, messageId: string) =>
    request(`/messages/conversation/${conversationId}/read`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),

  /**
   * Retrieves read receipts for a conversation showing who has read which messages.
   * @param conversationId - The UUID of the conversation
   * @returns Promise with array of read receipt objects
   */
  getReadReceipts: (conversationId: string) =>
    request<{ receipts: import('@/types').ReadReceipt[] }>(
      `/messages/conversation/${conversationId}/read-receipts`
    ),
};
