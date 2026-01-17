const API_BASE = '/api';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export const api = {
  // Auth
  register: (username: string, email: string, password: string) =>
    request<{ user: import('../types').User; sessionId: string }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    }),

  login: (username: string, password: string) =>
    request<{ user: import('../types').User; sessionId: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),

  getMe: () =>
    request<{ user: import('../types').User | null }>('/auth/me'),

  // Subreddits
  listSubreddits: (limit = 25, offset = 0) =>
    request<import('../types').Subreddit[]>(`/subreddits?limit=${limit}&offset=${offset}`),

  searchSubreddits: (query: string) =>
    request<import('../types').Subreddit[]>(`/subreddits?q=${encodeURIComponent(query)}`),

  getSubreddit: (name: string) =>
    request<import('../types').Subreddit>(`/subreddits/${name}`),

  createSubreddit: (name: string, title: string, description: string) =>
    request<import('../types').Subreddit>('/subreddits', {
      method: 'POST',
      body: JSON.stringify({ name, title, description }),
    }),

  subscribe: (subredditName: string) =>
    request<{ subscribed: boolean }>(`/subreddits/${subredditName}/subscribe`, {
      method: 'POST',
    }),

  unsubscribe: (subredditName: string) =>
    request<{ subscribed: boolean }>(`/subreddits/${subredditName}/unsubscribe`, {
      method: 'POST',
    }),

  // Posts
  listPosts: (sort = 'hot', limit = 25, offset = 0) =>
    request<import('../types').Post[]>(`/posts?sort=${sort}&limit=${limit}&offset=${offset}`),

  getSubredditPosts: (subredditName: string, sort = 'hot', limit = 25, offset = 0) =>
    request<import('../types').Post[]>(`/r/${subredditName}/${sort}?limit=${limit}&offset=${offset}`),

  getPost: (id: number) =>
    request<import('../types').Post>(`/posts/${id}`),

  getPostWithComments: (id: number, sort = 'best') =>
    request<{ post: import('../types').Post; comments: import('../types').Comment[] }>(
      `/posts/${id}/comments?sort=${sort}`
    ),

  createPost: (subredditName: string, title: string, content?: string, url?: string) =>
    request<import('../types').Post>(`/posts/r/${subredditName}`, {
      method: 'POST',
      body: JSON.stringify({ title, content, url }),
    }),

  // Comments
  createComment: (postId: number, content: string, parentId?: number) =>
    request<import('../types').Comment>(`/posts/${postId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content, parentId }),
    }),

  // Votes
  vote: (type: 'post' | 'comment', id: number, direction: 1 | -1 | 0) =>
    request<{ success: boolean; direction: number; score: number }>('/vote', {
      method: 'POST',
      body: JSON.stringify({ type, id, direction }),
    }),

  // Users
  getUser: (username: string) =>
    request<import('../types').User>(`/auth/users/${username}`),

  getUserPosts: (username: string, limit = 25, offset = 0) =>
    request<import('../types').Post[]>(
      `/auth/users/${username}/posts?limit=${limit}&offset=${offset}`
    ),
};

export default api;
