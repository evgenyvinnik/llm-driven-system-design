/**
 * API client module for communicating with the backend.
 * Provides typed wrappers around fetch for all API endpoints.
 * Handles credentials, JSON serialization, and error responses.
 */

/** Base URL for API requests (proxied in development via Vite) */
const API_BASE = '/api';

/**
 * Generic request helper that wraps fetch with common configuration.
 * Automatically includes credentials and handles JSON response parsing.
 * @param endpoint - API endpoint path (appended to API_BASE)
 * @param options - Fetch options (method, body, headers)
 * @returns Parsed JSON response
 * @throws Error with message from API response
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
 * Handles login, registration, logout, and current user retrieval.
 */
export const authApi = {
  login: (email: string, password: string) =>
    request<{ id: string; email: string; name: string; is_admin: boolean }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (data: {
    email: string;
    password: string;
    name: string;
    birthdate: string;
    gender: string;
    bio?: string;
  }) =>
    request<{ id: string; email: string; name: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', {
      method: 'POST',
    }),

  getMe: () =>
    request<import('../types').User>('/auth/me'),
};

/**
 * User profile and settings API endpoints.
 * Handles profile updates, location, preferences, and photo management.
 */
export const userApi = {
  getProfile: () =>
    request<import('../types').User>('/users/profile'),

  updateProfile: (data: {
    name?: string;
    bio?: string;
    job_title?: string;
    company?: string;
    school?: string;
  }) =>
    request<import('../types').User>('/users/profile', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  updateLocation: (latitude: number, longitude: number) =>
    request<{ message: string }>('/users/location', {
      method: 'PUT',
      body: JSON.stringify({ latitude, longitude }),
    }),

  getPreferences: () =>
    request<import('../types').UserPreferences>('/users/preferences'),

  updatePreferences: (data: Partial<import('../types').UserPreferences>) =>
    request<import('../types').UserPreferences>('/users/preferences', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  getPhotos: () =>
    request<import('../types').Photo[]>('/users/photos'),

  uploadPhoto: async (file: File, position: number) => {
    const formData = new FormData();
    formData.append('photo', file);
    formData.append('position', position.toString());

    const response = await fetch(`${API_BASE}/users/photos`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error || 'Upload failed');
    }

    return response.json() as Promise<import('../types').Photo>;
  },

  deletePhoto: (photoId: string) =>
    request<{ message: string }>(`/users/photos/${photoId}`, {
      method: 'DELETE',
    }),
};

/**
 * Discovery and swiping API endpoints.
 * Handles deck retrieval, profile viewing, and swipe actions.
 */
export const discoveryApi = {
  getDeck: (limit = 20) =>
    request<import('../types').DiscoveryCard[]>(`/discovery/deck?limit=${limit}`),

  getProfile: (userId: string) =>
    request<import('../types').DiscoveryCard>(`/discovery/profile/${userId}`),

  swipe: (userId: string, direction: 'like' | 'pass') =>
    request<import('../types').SwipeResult>('/discovery/swipe', {
      method: 'POST',
      body: JSON.stringify({ userId, direction }),
    }),

  getLikes: () =>
    request<Array<{ id: string; name: string; age: number; primary_photo: string | null }>>(
      '/discovery/likes'
    ),
};

/**
 * Match and messaging API endpoints.
 * Handles match list, messages, read receipts, and unmatching.
 */
export const matchApi = {
  getMatches: () =>
    request<import('../types').Match[]>('/matches'),

  getMessages: (matchId: string, limit = 50, before?: string) =>
    request<import('../types').Message[]>(
      `/matches/${matchId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`
    ),

  sendMessage: (matchId: string, content: string) =>
    request<import('../types').Message>(`/matches/${matchId}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  markAsRead: (matchId: string) =>
    request<{ success: boolean }>(`/matches/${matchId}/read`, {
      method: 'POST',
    }),

  unmatch: (matchId: string) =>
    request<{ message: string }>(`/matches/${matchId}`, {
      method: 'DELETE',
    }),

  getUnreadCount: () =>
    request<{ count: number }>('/matches/unread/count'),
};

/**
 * Admin dashboard API endpoints.
 * Provides statistics, user management, and activity monitoring.
 */
export const adminApi = {
  getStats: () =>
    request<import('../types').AdminStats>('/admin/stats'),

  getUsers: (limit = 50, offset = 0) =>
    request<{
      users: import('../types').User[];
      total: number;
      limit: number;
      offset: number;
    }>(`/admin/users?limit=${limit}&offset=${offset}`),

  getUser: (userId: string) =>
    request<import('../types').User>(`/admin/users/${userId}`),

  banUser: (userId: string) =>
    request<{ message: string }>(`/admin/users/${userId}/ban`, {
      method: 'POST',
    }),

  unbanUser: (userId: string) =>
    request<{ message: string }>(`/admin/users/${userId}/unban`, {
      method: 'POST',
    }),

  deleteUser: (userId: string) =>
    request<{ message: string }>(`/admin/users/${userId}`, {
      method: 'DELETE',
    }),

  getActivity: () =>
    request<{
      recentMatches: Array<{
        id: string;
        matched_at: string;
        user1_name: string;
        user2_name: string;
      }>;
      recentSignups: Array<{
        id: string;
        name: string;
        email: string;
        created_at: string;
        gender: string;
      }>;
    }>('/admin/activity'),
};
