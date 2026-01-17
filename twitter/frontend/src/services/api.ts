const API_BASE = '/api';

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

// Auth API
export const authApi = {
  async login(username: string, password: string) {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    return handleResponse<{ user: import('../types').User }>(response);
  },

  async register(username: string, email: string, password: string, displayName?: string) {
    const response = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, email, password, displayName }),
    });
    return handleResponse<{ user: import('../types').User }>(response);
  },

  async logout() {
    const response = await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  async getMe() {
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
    });
    return handleResponse<{ user: import('../types').User }>(response);
  },
};

// Users API
export const usersApi = {
  async getUser(username: string) {
    const response = await fetch(`${API_BASE}/users/${username}`, {
      credentials: 'include',
    });
    return handleResponse<{ user: import('../types').User }>(response);
  },

  async follow(userId: number) {
    const response = await fetch(`${API_BASE}/users/${userId}/follow`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  async unfollow(userId: number) {
    const response = await fetch(`${API_BASE}/users/${userId}/follow`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  async getFollowers(userId: number, limit = 20, offset = 0) {
    const response = await fetch(`${API_BASE}/users/${userId}/followers?limit=${limit}&offset=${offset}`, {
      credentials: 'include',
    });
    return handleResponse<{ users: import('../types').User[] }>(response);
  },

  async getFollowing(userId: number, limit = 20, offset = 0) {
    const response = await fetch(`${API_BASE}/users/${userId}/following?limit=${limit}&offset=${offset}`, {
      credentials: 'include',
    });
    return handleResponse<{ users: import('../types').User[] }>(response);
  },

  async search(query: string, limit = 20) {
    const response = await fetch(`${API_BASE}/users?q=${encodeURIComponent(query)}&limit=${limit}`, {
      credentials: 'include',
    });
    return handleResponse<{ users: import('../types').User[] }>(response);
  },
};

// Tweets API
export const tweetsApi = {
  async create(content: string, options?: { replyTo?: string; quoteOf?: string; mediaUrls?: string[] }) {
    const response = await fetch(`${API_BASE}/tweets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content, ...options }),
    });
    return handleResponse<{ tweet: import('../types').Tweet }>(response);
  },

  async get(tweetId: string) {
    const response = await fetch(`${API_BASE}/tweets/${tweetId}`, {
      credentials: 'include',
    });
    return handleResponse<{ tweet: import('../types').Tweet }>(response);
  },

  async delete(tweetId: string) {
    const response = await fetch(`${API_BASE}/tweets/${tweetId}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  async like(tweetId: string) {
    const response = await fetch(`${API_BASE}/tweets/${tweetId}/like`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse<{ message: string; likeCount: number }>(response);
  },

  async unlike(tweetId: string) {
    const response = await fetch(`${API_BASE}/tweets/${tweetId}/like`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string; likeCount: number }>(response);
  },

  async retweet(tweetId: string) {
    const response = await fetch(`${API_BASE}/tweets/${tweetId}/retweet`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse<{ message: string; retweetCount: number }>(response);
  },

  async unretweet(tweetId: string) {
    const response = await fetch(`${API_BASE}/tweets/${tweetId}/retweet`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string; retweetCount: number }>(response);
  },

  async getReplies(tweetId: string, limit = 20, offset = 0) {
    const response = await fetch(`${API_BASE}/tweets/${tweetId}/replies?limit=${limit}&offset=${offset}`, {
      credentials: 'include',
    });
    return handleResponse<{ tweets: import('../types').Tweet[] }>(response);
  },
};

// Timeline API
export const timelineApi = {
  async getHome(limit = 50, before?: string) {
    const url = new URL(`${API_BASE}/timeline/home`, window.location.origin);
    url.searchParams.set('limit', limit.toString());
    if (before) url.searchParams.set('before', before);

    const response = await fetch(url.toString(), {
      credentials: 'include',
    });
    return handleResponse<{ tweets: import('../types').Tweet[]; nextCursor: string | null }>(response);
  },

  async getUserTimeline(username: string, limit = 50, before?: string) {
    const url = new URL(`${API_BASE}/timeline/user/${username}`, window.location.origin);
    url.searchParams.set('limit', limit.toString());
    if (before) url.searchParams.set('before', before);

    const response = await fetch(url.toString(), {
      credentials: 'include',
    });
    return handleResponse<{ tweets: import('../types').Tweet[]; nextCursor: string | null }>(response);
  },

  async getExplore(limit = 50, before?: string) {
    const url = new URL(`${API_BASE}/timeline/explore`, window.location.origin);
    url.searchParams.set('limit', limit.toString());
    if (before) url.searchParams.set('before', before);

    const response = await fetch(url.toString(), {
      credentials: 'include',
    });
    return handleResponse<{ tweets: import('../types').Tweet[]; nextCursor: string | null }>(response);
  },

  async getHashtag(hashtag: string, limit = 50, before?: string) {
    const url = new URL(`${API_BASE}/timeline/hashtag/${hashtag}`, window.location.origin);
    url.searchParams.set('limit', limit.toString());
    if (before) url.searchParams.set('before', before);

    const response = await fetch(url.toString(), {
      credentials: 'include',
    });
    return handleResponse<{ hashtag: string; tweets: import('../types').Tweet[]; nextCursor: string | null }>(response);
  },
};

// Trends API
export const trendsApi = {
  async getTrends(limit = 10) {
    const response = await fetch(`${API_BASE}/trends?limit=${limit}`, {
      credentials: 'include',
    });
    return handleResponse<{ trends: import('../types').Trend[]; updatedAt: string }>(response);
  },

  async getAllTime(limit = 10) {
    const response = await fetch(`${API_BASE}/trends/all-time?limit=${limit}`, {
      credentials: 'include',
    });
    return handleResponse<{ trends: import('../types').Trend[] }>(response);
  },
};
