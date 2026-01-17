import type {
  Post,
  User,
  UserWithFollowStatus,
  FeedResponse,
  CommentsResponse,
  Comment,
  AuthResponse,
  CreatePostRequest,
  LoginRequest,
  RegisterRequest,
} from '@/types';

const API_BASE = '/api/v1';

class ApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

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
    throw new ApiError(error.error || 'Request failed', response.status);
  }

  return response.json();
}

// Auth API
export const authApi = {
  login: (data: LoginRequest) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  register: (data: RegisterRequest) =>
    request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', { method: 'POST' }),

  getMe: () => request<User>('/auth/me'),
};

// Users API
export const usersApi = {
  getUser: (username: string) =>
    request<UserWithFollowStatus>(`/users/${username}`),

  updateProfile: (data: Partial<User>) =>
    request<User>('/users/me', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  getUserPosts: (username: string, cursor?: string) => {
    const params = new URLSearchParams({ limit: '20' });
    if (cursor) params.set('cursor', cursor);
    return request<FeedResponse>(`/users/${username}/posts?${params}`);
  },

  getFollowers: (username: string, offset = 0) =>
    request<{ users: User[]; has_more: boolean }>(
      `/users/${username}/followers?limit=20&offset=${offset}`
    ),

  getFollowing: (username: string, offset = 0) =>
    request<{ users: User[]; has_more: boolean }>(
      `/users/${username}/following?limit=20&offset=${offset}`
    ),

  follow: (username: string) =>
    request<{ message: string }>(`/users/${username}/follow`, { method: 'POST' }),

  unfollow: (username: string) =>
    request<{ message: string }>(`/users/${username}/follow`, { method: 'DELETE' }),

  searchUsers: (query: string) =>
    request<{ users: User[] }>(`/users?q=${encodeURIComponent(query)}`),
};

// Posts API
export const postsApi = {
  createPost: (data: CreatePostRequest) =>
    request<Post>('/posts', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getPost: (postId: string) => request<Post>(`/posts/${postId}`),

  deletePost: (postId: string) =>
    request<{ message: string }>(`/posts/${postId}`, { method: 'DELETE' }),

  likePost: (postId: string) =>
    request<{ message: string }>(`/posts/${postId}/like`, { method: 'POST' }),

  unlikePost: (postId: string) =>
    request<{ message: string }>(`/posts/${postId}/like`, { method: 'DELETE' }),

  getComments: (postId: string, offset = 0) =>
    request<CommentsResponse>(`/posts/${postId}/comments?limit=20&offset=${offset}`),

  addComment: (postId: string, content: string) =>
    request<Comment>(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),

  deleteComment: (postId: string, commentId: string) =>
    request<{ message: string }>(`/posts/${postId}/comments/${commentId}`, {
      method: 'DELETE',
    }),
};

// Feed API
export const feedApi = {
  getFeed: (cursor?: string) => {
    const params = new URLSearchParams({ limit: '20' });
    if (cursor) params.set('cursor', cursor);
    return request<FeedResponse>(`/feed?${params}`);
  },

  getExploreFeed: (offset = 0) =>
    request<FeedResponse>(`/feed/explore?limit=20&offset=${offset}`),
};

export { ApiError };
