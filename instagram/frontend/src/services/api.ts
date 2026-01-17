const API_BASE = '/api/v1';

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

async function requestFormData<T>(
  endpoint: string,
  formData: FormData,
  method = 'POST'
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    method,
    body: formData,
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

// Auth
export const authApi = {
  register: (data: { username: string; email: string; password: string; displayName?: string }) =>
    request('/auth/register', { method: 'POST', body: JSON.stringify(data) }),

  login: (data: { username: string; password: string }) =>
    request('/auth/login', { method: 'POST', body: JSON.stringify(data) }),

  logout: () => request('/auth/logout', { method: 'POST' }),

  getMe: () => request<{ user: import('../types').User }>('/auth/me'),
};

// Posts
export const postsApi = {
  create: (formData: FormData) =>
    requestFormData<{ post: import('../types').Post }>('/posts', formData),

  get: (postId: string) =>
    request<{ post: import('../types').Post }>(`/posts/${postId}`),

  delete: (postId: string) =>
    request(`/posts/${postId}`, { method: 'DELETE' }),

  like: (postId: string) =>
    request(`/posts/${postId}/like`, { method: 'POST' }),

  unlike: (postId: string) =>
    request(`/posts/${postId}/like`, { method: 'DELETE' }),

  save: (postId: string) =>
    request(`/posts/${postId}/save`, { method: 'POST' }),

  unsave: (postId: string) =>
    request(`/posts/${postId}/save`, { method: 'DELETE' }),

  getLikes: (postId: string, cursor?: string) =>
    request<{ likes: import('../types').User[]; nextCursor: string | null }>(
      `/posts/${postId}/likes${cursor ? `?cursor=${cursor}` : ''}`
    ),
};

// Comments
export const commentsApi = {
  getComments: (postId: string, cursor?: string) =>
    request<{ comments: import('../types').Comment[]; nextCursor: string | null }>(
      `/posts/${postId}/comments${cursor ? `?cursor=${cursor}` : ''}`
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
export const usersApi = {
  getProfile: (username: string) =>
    request<{ user: import('../types').User }>(`/users/${username}`),

  updateProfile: (formData: FormData) =>
    requestFormData<{ user: import('../types').User }>('/users/me', formData, 'PUT'),

  getPosts: (username: string, cursor?: string) =>
    request<{ posts: import('../types').PostThumbnail[]; nextCursor: string | null }>(
      `/users/${username}/posts${cursor ? `?cursor=${cursor}` : ''}`
    ),

  getSavedPosts: (cursor?: string) =>
    request<{ posts: import('../types').PostThumbnail[]; nextCursor: string | null }>(
      `/users/me/saved${cursor ? `?cursor=${cursor}` : ''}`
    ),

  follow: (userId: string) =>
    request(`/users/${userId}/follow`, { method: 'POST' }),

  unfollow: (userId: string) =>
    request(`/users/${userId}/follow`, { method: 'DELETE' }),

  getFollowers: (username: string, cursor?: string) =>
    request<{ followers: import('../types').User[]; nextCursor: string | null }>(
      `/users/${username}/followers${cursor ? `?cursor=${cursor}` : ''}`
    ),

  getFollowing: (username: string, cursor?: string) =>
    request<{ following: import('../types').User[]; nextCursor: string | null }>(
      `/users/${username}/following${cursor ? `?cursor=${cursor}` : ''}`
    ),

  search: (query: string) =>
    request<{ users: import('../types').User[] }>(`/users/search/users?q=${encodeURIComponent(query)}`),
};

// Feed
export const feedApi = {
  getFeed: (cursor?: string) =>
    request<{ posts: import('../types').Post[]; nextCursor: string | null }>(
      `/feed${cursor ? `?cursor=${cursor}` : ''}`
    ),

  getExplore: (cursor?: string) =>
    request<{ posts: import('../types').PostThumbnail[]; nextCursor: string | null }>(
      `/feed/explore${cursor ? `?cursor=${cursor}` : ''}`
    ),
};

// Stories
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
      `/stories/${storyId}/viewers${cursor ? `?cursor=${cursor}` : ''}`
    ),

  delete: (storyId: string) =>
    request(`/stories/${storyId}`, { method: 'DELETE' }),
};
