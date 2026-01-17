/**
 * API client for the LinkedIn clone frontend.
 * Provides typed methods for all backend API endpoints.
 * Handles request formatting, error handling, and credential management.
 *
 * @module services/api
 */

/** Base URL for API requests, proxied by Vite in development */
const API_BASE = '/api';

/**
 * Generic fetch wrapper with JSON handling and error management.
 * Automatically includes credentials and Content-Type header.
 *
 * @template T - Expected response type
 * @param path - API endpoint path (will be prefixed with /api)
 * @param options - Fetch options (method, body, headers)
 * @returns Parsed JSON response
 * @throws Error with message from API response or "Request failed"
 */
async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
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
 * Handles login, registration, logout, and session verification.
 */
export const authApi = {
  login: (email: string, password: string) =>
    request<{ user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (data: { email: string; password: string; firstName: string; lastName: string; headline?: string }) =>
    request<{ user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ user: import('../types').User }>('/auth/me'),
};

/**
 * User profile API endpoints.
 * Handles profile viewing, editing, search, and profile section management.
 */
export const usersApi = {
  getProfile: (id: number) =>
    request<{
      user: import('../types').User;
      experiences: import('../types').Experience[];
      education: import('../types').Education[];
      skills: import('../types').UserSkill[];
    }>(`/users/${id}`),

  updateProfile: (data: Partial<import('../types').User>) =>
    request<{ user: import('../types').User }>('/users/me', {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  search: (query: string) =>
    request<{ users: import('../types').User[] }>(`/users?q=${encodeURIComponent(query)}`),

  addExperience: (data: Partial<import('../types').Experience>) =>
    request<{ experience: import('../types').Experience }>('/users/me/experiences', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteExperience: (id: number) =>
    request<{ message: string }>(`/users/me/experiences/${id}`, { method: 'DELETE' }),

  addEducation: (data: Partial<import('../types').Education>) =>
    request<{ education: import('../types').Education }>('/users/me/education', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteEducation: (id: number) =>
    request<{ message: string }>(`/users/me/education/${id}`, { method: 'DELETE' }),

  addSkill: (name: string) =>
    request<{ skills: import('../types').UserSkill[] }>('/users/me/skills', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  removeSkill: (skillId: number) =>
    request<{ message: string }>(`/users/me/skills/${skillId}`, { method: 'DELETE' }),

  endorseSkill: (userId: number, skillId: number) =>
    request<{ message: string }>(`/users/${userId}/skills/${skillId}/endorse`, { method: 'POST' }),
};

/**
 * Connection API endpoints.
 * Manages the professional network graph and PYMK recommendations.
 */
export const connectionsApi = {
  getConnections: (offset = 0, limit = 20) =>
    request<{ connections: import('../types').User[] }>(`/connections?offset=${offset}&limit=${limit}`),

  getPendingRequests: () =>
    request<{ requests: import('../types').ConnectionRequest[] }>('/connections/requests'),

  sendRequest: (userId: number, message?: string) =>
    request<{ request: import('../types').ConnectionRequest }>('/connections/request', {
      method: 'POST',
      body: JSON.stringify({ userId, message }),
    }),

  acceptRequest: (requestId: number) =>
    request<{ message: string }>(`/connections/requests/${requestId}/accept`, { method: 'POST' }),

  rejectRequest: (requestId: number) =>
    request<{ message: string }>(`/connections/requests/${requestId}/reject`, { method: 'POST' }),

  removeConnection: (userId: number) =>
    request<{ message: string }>(`/connections/${userId}`, { method: 'DELETE' }),

  getConnectionDegree: (userId: number) =>
    request<{ degree: number | null }>(`/connections/degree/${userId}`),

  getMutualConnections: (userId: number) =>
    request<{ mutual_connections: import('../types').User[] }>(`/connections/mutual/${userId}`),

  getSecondDegree: () =>
    request<{ connections: { user_id: number; degree: number; mutual_count: number }[] }>('/connections/second-degree'),

  getPYMK: (limit = 10) =>
    request<{ people: import('../types').PYMKCandidate[] }>(`/connections/pymk?limit=${limit}`),
};

/**
 * Feed API endpoints.
 * Handles posts, likes, comments, and feed generation.
 */
export const feedApi = {
  getFeed: (offset = 0, limit = 20) =>
    request<{ posts: import('../types').Post[] }>(`/feed?offset=${offset}&limit=${limit}`),

  createPost: (content: string, imageUrl?: string) =>
    request<{ post: import('../types').Post }>('/feed', {
      method: 'POST',
      body: JSON.stringify({ content, imageUrl }),
    }),

  getPost: (id: number) =>
    request<{ post: import('../types').Post }>(`/feed/${id}`),

  deletePost: (id: number) =>
    request<{ message: string }>(`/feed/${id}`, { method: 'DELETE' }),

  likePost: (id: number) =>
    request<{ message: string }>(`/feed/${id}/like`, { method: 'POST' }),

  unlikePost: (id: number) =>
    request<{ message: string }>(`/feed/${id}/like`, { method: 'DELETE' }),

  getComments: (postId: number) =>
    request<{ comments: import('../types').PostComment[] }>(`/feed/${postId}/comments`),

  addComment: (postId: number, content: string) =>
    request<{ comment: import('../types').PostComment }>(`/feed/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  getUserPosts: (userId: number, offset = 0, limit = 20) =>
    request<{ posts: import('../types').Post[] }>(`/feed/user/${userId}?offset=${offset}&limit=${limit}`),
};

/**
 * Jobs API endpoints.
 * Handles job search, listings, applications, and recommendations.
 */
export const jobsApi = {
  getJobs: (params?: {
    q?: string;
    location?: string;
    is_remote?: boolean;
    employment_type?: string;
    experience_level?: string;
    offset?: number;
    limit?: number;
  }) => {
    const searchParams = new URLSearchParams();
    if (params?.q) searchParams.set('q', params.q);
    if (params?.location) searchParams.set('location', params.location);
    if (params?.is_remote !== undefined) searchParams.set('is_remote', String(params.is_remote));
    if (params?.employment_type) searchParams.set('employment_type', params.employment_type);
    if (params?.experience_level) searchParams.set('experience_level', params.experience_level);
    if (params?.offset) searchParams.set('offset', String(params.offset));
    if (params?.limit) searchParams.set('limit', String(params.limit));

    return request<{ jobs: import('../types').Job[] }>(`/jobs?${searchParams}`);
  },

  getJob: (id: number) =>
    request<{ job: import('../types').Job; match_score: number | null }>(`/jobs/${id}`),

  getRecommended: (limit = 10) =>
    request<{ jobs: import('../types').Job[] }>(`/jobs/recommended?limit=${limit}`),

  apply: (jobId: number, data: { resume_url?: string; cover_letter?: string }) =>
    request<{ application: import('../types').JobApplication }>(`/jobs/${jobId}/apply`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getMyApplications: () =>
    request<{ applications: import('../types').JobApplication[] }>('/jobs/my/applications'),

  getCompanies: () =>
    request<{ companies: import('../types').Company[] }>('/jobs/companies'),

  getCompany: (slug: string) =>
    request<{ company: import('../types').Company }>(`/jobs/companies/${slug}`),
};
