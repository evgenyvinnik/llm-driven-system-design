const API_BASE = '/api/v1';

/** Error carrying the HTTP status, so callers can tell 404 from 429 from a network failure. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({ error: 'Request failed' }));
  return new ApiError(body.error || 'Request failed', response.status);
}

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
    throw await toApiError(response);
  }

  return response.json();
}

async function requestFormData<T>(
  endpoint: string,
  formData: FormData,
  method = 'POST',
  headers: Record<string, string> = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method,
    body: formData,
    headers,
    credentials: 'include',
  });

  if (!response.ok) {
    throw await toApiError(response);
  }

  return response.json();
}

/** Result of an idempotent toggle: `idempotent: true` means the server state already matched. */
export interface ToggleResult {
  message: string;
  idempotent?: boolean;
}

const withCursor = (path: string, cursor?: string) =>
  cursor ? `${path}${path.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(cursor)}` : path;

// Auth
/** API client for authentication: register, login, logout, and session check. */
export const authApi = {
  register: (data: { username: string; email: string; password: string; displayName?: string }) =>
    request('/auth/register', { method: 'POST', body: JSON.stringify(data) }),

  login: (data: { username: string; password: string }) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify(data) }),

  logout: () => request('/auth/logout', { method: 'POST' }),

  getMe: () => request<{ user: import('../types').User }>('/auth/me'),
};

// Posts
/** API client for post CRUD, likes, and post retrieval. */
export const postsApi = {
  /**
   * The Idempotency-Key identifies one draft: retries of the same draft reuse it, so a timed-out
   * upload that actually succeeded is answered with the original post instead of a duplicate.
   */
  create: (formData: FormData, idempotencyKey: string) =>
    requestFormData<{ post: import('../types').Post; message?: string }>('/posts', formData, 'POST', {
      'Idempotency-Key': idempotencyKey,
    }),

  get: (postId: string) =>
    request<{ post: import('../types').Post }>(`/posts/${postId}`),

  delete: (postId: string) =>
    request(`/posts/${postId}`, { method: 'DELETE' }),

  like: (postId: string) =>
    request<ToggleResult>(`/posts/${postId}/like`, { method: 'POST' }),

  unlike: (postId: string) =>
    request<ToggleResult>(`/posts/${postId}/like`, { method: 'DELETE' }),

  save: (postId: string) =>
    request<ToggleResult>(`/posts/${postId}/save`, { method: 'POST' }),

  unsave: (postId: string) =>
    request<ToggleResult>(`/posts/${postId}/save`, { method: 'DELETE' }),

  getLikes: (postId: string, cursor?: string) =>
    request<{ likes: import('../types').User[]; nextCursor: string | null }>(
      withCursor(`/posts/${postId}/likes`, cursor)
    ),
};

// Comments
/** API client for comment CRUD on posts. */
export const commentsApi = {
  getComments: (postId: string, cursor?: string) =>
    request<{ comments: import('../types').Comment[]; nextCursor: string | null }>(
      withCursor(`/posts/${postId}/comments`, cursor)
    ),

  addComment: (postId: string, content: string, parentCommentId?: string) =>
    request<{ comment: import('../types').Comment }>(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content, parentCommentId }),
    }),

  deleteComment: (commentId: string) =>
    request(`/comments/${commentId}`, { method: 'DELETE' }),

  likeComment: (commentId: string) =>
    request(`/comments/${commentId}/like`, { method: 'POST' }),

  unlikeComment: (commentId: string) =>
    request(`/comments/${commentId}/like`, { method: 'DELETE' }),
};

// Users
/** API client for user profiles, follow/unfollow, and user search. */
export const usersApi = {
  getProfile: (username: string) =>
    request<{ user: import('../types').User }>(`/users/${username}`),

  updateProfile: (formData: FormData) =>
    requestFormData<{ user: import('../types').User }>('/users/me', formData, 'PUT'),

  getPosts: (username: string, cursor?: string) =>
    request<{ posts: import('../types').PostThumbnail[]; nextCursor: string | null }>(
      withCursor(`/users/${username}/posts`, cursor)
    ),

  getSavedPosts: (cursor?: string) =>
    request<{ posts: import('../types').PostThumbnail[]; nextCursor: string | null }>(
      withCursor('/users/me/saved', cursor)
    ),

  follow: (userId: string) =>
    request(`/users/${userId}/follow`, { method: 'POST' }),

  unfollow: (userId: string) =>
    request(`/users/${userId}/follow`, { method: 'DELETE' }),

  getFollowers: (username: string, cursor?: string) =>
    request<{ followers: import('../types').User[]; nextCursor: string | null }>(
      withCursor(`/users/${username}/followers`, cursor)
    ),

  getFollowing: (username: string, cursor?: string) =>
    request<{ following: import('../types').User[]; nextCursor: string | null }>(
      withCursor(`/users/${username}/following`, cursor)
    ),

  search: (query: string) =>
    request<{ users: import('../types').User[] }>(`/users/search/users?q=${encodeURIComponent(query)}`),
};

// Feed
/**
 * API client for personalized feed retrieval with pagination. Cursors are opaque strings from
 * the server (`<created_ms>_<post id>` for the home feed); the client only passes them back.
 * `degraded` is set when the server served an empty page because a dependency is struggling.
 */
export const feedApi = {
  getFeed: (cursor?: string) =>
    request<{ posts: import('../types').Post[]; nextCursor: string | null; degraded?: boolean }>(
      withCursor('/feed', cursor)
    ),

  getExplore: (cursor?: string) =>
    request<{ posts: import('../types').PostThumbnail[]; nextCursor: string | null }>(
      withCursor('/feed/explore', cursor)
    ),
};

// Stories
/** API client for story creation, viewing, and story tray retrieval. */
export const storiesApi = {
  create: (formData: FormData) =>
    requestFormData<{ story: import('../types').Story }>('/stories', formData),

  getTray: () =>
    request<{ users: import('../types').StoryUser[] }>('/stories/tray'),

  getUserStories: (userId: string) =>
    request<{
      user: import('../types').User;
      stories: import('../types').Story[];
    }>(`/stories/user/${userId}`),

  getMyStories: () =>
    request<{ stories: import('../types').Story[] }>('/stories/me'),

  view: (storyId: string) =>
    request(`/stories/${storyId}/view`, { method: 'POST' }),

  getViewers: (storyId: string, cursor?: string) =>
    request<{ viewers: import('../types').User[]; nextCursor: string | null }>(
      withCursor(`/stories/${storyId}/viewers`, cursor)
    ),

  delete: (storyId: string) =>
    request(`/stories/${storyId}`, { method: 'DELETE' }),
};
