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
  async register(username: string, email: string, password: string, displayName?: string) {
    const response = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, email, password, displayName }),
    });
    return handleResponse(response);
  },

  async login(username: string, password: string) {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, password }),
    });
    return handleResponse(response);
  },

  async logout() {
    const response = await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse(response);
  },

  async getMe() {
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
    });
    return handleResponse(response);
  },
};

// Users API
export const usersApi = {
  async getProfile(username: string) {
    const response = await fetch(`${API_BASE}/users/${username}`, {
      credentials: 'include',
    });
    return handleResponse(response);
  },

  async updateProfile(data: { displayName?: string; bio?: string; avatarUrl?: string }) {
    const response = await fetch(`${API_BASE}/users/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(data),
    });
    return handleResponse(response);
  },

  async follow(username: string) {
    const response = await fetch(`${API_BASE}/users/${username}/follow`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse(response);
  },

  async unfollow(username: string) {
    const response = await fetch(`${API_BASE}/users/${username}/follow`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse(response);
  },

  async getFollowers(username: string, limit = 20, offset = 0) {
    const response = await fetch(
      `${API_BASE}/users/${username}/followers?limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },

  async getFollowing(username: string, limit = 20, offset = 0) {
    const response = await fetch(
      `${API_BASE}/users/${username}/following?limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },
};

// Videos API
export const videosApi = {
  async upload(file: File, description: string, hashtags: string[]) {
    const formData = new FormData();
    formData.append('video', file);
    formData.append('description', description);
    formData.append('hashtags', hashtags.join(','));

    const response = await fetch(`${API_BASE}/videos`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    return handleResponse(response);
  },

  async getVideo(id: number) {
    const response = await fetch(`${API_BASE}/videos/${id}`, {
      credentials: 'include',
    });
    return handleResponse(response);
  },

  async getUserVideos(username: string, limit = 20, offset = 0) {
    const response = await fetch(
      `${API_BASE}/videos/user/${username}?limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },

  async deleteVideo(id: number) {
    const response = await fetch(`${API_BASE}/videos/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse(response);
  },

  async recordView(id: number, watchDurationMs: number, completionRate: number) {
    const response = await fetch(`${API_BASE}/videos/${id}/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ watchDurationMs, completionRate }),
    });
    return handleResponse(response);
  },

  async like(id: number) {
    const response = await fetch(`${API_BASE}/videos/${id}/like`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse(response);
  },

  async unlike(id: number) {
    const response = await fetch(`${API_BASE}/videos/${id}/like`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse(response);
  },
};

// Feed API
export const feedApi = {
  async getFyp(limit = 10, offset = 0) {
    const response = await fetch(
      `${API_BASE}/feed/fyp?limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },

  async getFollowing(limit = 10, offset = 0) {
    const response = await fetch(
      `${API_BASE}/feed/following?limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },

  async getTrending(limit = 10, offset = 0) {
    const response = await fetch(
      `${API_BASE}/feed/trending?limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },

  async getHashtag(tag: string, limit = 10, offset = 0) {
    const response = await fetch(
      `${API_BASE}/feed/hashtag/${tag}?limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },

  async search(query: string, limit = 10, offset = 0) {
    const response = await fetch(
      `${API_BASE}/feed/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },
};

// Comments API
export const commentsApi = {
  async getComments(videoId: number, limit = 20, offset = 0) {
    const response = await fetch(
      `${API_BASE}/comments/video/${videoId}?limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },

  async getReplies(commentId: number, limit = 20, offset = 0) {
    const response = await fetch(
      `${API_BASE}/comments/${commentId}/replies?limit=${limit}&offset=${offset}`,
      { credentials: 'include' }
    );
    return handleResponse(response);
  },

  async createComment(videoId: number, content: string, parentId?: number) {
    const response = await fetch(`${API_BASE}/comments/video/${videoId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ content, parentId }),
    });
    return handleResponse(response);
  },

  async deleteComment(id: number) {
    const response = await fetch(`${API_BASE}/comments/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse(response);
  },
};
