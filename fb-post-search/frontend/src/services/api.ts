import type { User, SearchResponse, SearchFilters, SearchSuggestion, Post, AdminStats, SearchHistoryEntry } from '../types';

const API_BASE = '/api/v1';

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('auth_token', token);
    } else {
      localStorage.removeItem('auth_token');
    }
  }

  getToken(): string | null {
    if (!this.token) {
      this.token = localStorage.getItem('auth_token');
    }
    return this.token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const token = this.getToken();
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
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

  // Auth
  async login(username: string, password: string): Promise<{ token: string; user: User }> {
    const response = await this.request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    this.setToken(response.token);
    return response;
  }

  async register(username: string, email: string, display_name: string, password: string): Promise<{ token: string; user: User }> {
    const response = await this.request<{ token: string; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, display_name, password }),
    });
    this.setToken(response.token);
    return response;
  }

  async logout(): Promise<void> {
    await this.request('/auth/logout', { method: 'POST' }).catch(() => {});
    this.setToken(null);
  }

  async getCurrentUser(): Promise<User> {
    return this.request<User>('/auth/me');
  }

  // Search
  async search(
    query: string,
    filters?: SearchFilters,
    cursor?: string,
    limit?: number
  ): Promise<SearchResponse> {
    return this.request<SearchResponse>('/search', {
      method: 'POST',
      body: JSON.stringify({
        query,
        filters,
        pagination: { cursor, limit },
      }),
    });
  }

  async getSuggestions(query: string, limit: number = 10): Promise<{ suggestions: SearchSuggestion[] }> {
    return this.request<{ suggestions: SearchSuggestion[] }>(
      `/search/suggestions?q=${encodeURIComponent(query)}&limit=${limit}`
    );
  }

  async getTrending(limit: number = 10): Promise<{ trending: string[] }> {
    return this.request<{ trending: string[] }>(`/search/trending?limit=${limit}`);
  }

  async getRecentSearches(limit: number = 10): Promise<{ searches: string[] }> {
    return this.request<{ searches: string[] }>(`/search/recent?limit=${limit}`);
  }

  async clearSearchHistory(): Promise<void> {
    await this.request('/search/history', { method: 'DELETE' });
  }

  // Posts
  async createPost(
    content: string,
    visibility: string = 'friends',
    post_type: string = 'text'
  ): Promise<Post> {
    return this.request<Post>('/posts', {
      method: 'POST',
      body: JSON.stringify({ content, visibility, post_type }),
    });
  }

  async getFeed(limit: number = 20, offset: number = 0): Promise<{ posts: Post[] }> {
    return this.request<{ posts: Post[] }>(`/posts/feed?limit=${limit}&offset=${offset}`);
  }

  async likePost(postId: string): Promise<Post> {
    return this.request<Post>(`/posts/${postId}/like`, { method: 'POST' });
  }

  async deletePost(postId: string): Promise<void> {
    await this.request(`/posts/${postId}`, { method: 'DELETE' });
  }

  // Admin
  async getAdminStats(): Promise<AdminStats> {
    return this.request<AdminStats>('/admin/stats');
  }

  async getAdminUsers(limit: number = 50, offset: number = 0): Promise<{ users: User[] }> {
    return this.request<{ users: User[] }>(`/admin/users?limit=${limit}&offset=${offset}`);
  }

  async getAdminPosts(limit: number = 50, offset: number = 0): Promise<{ posts: Post[] }> {
    return this.request<{ posts: Post[] }>(`/admin/posts?limit=${limit}&offset=${offset}`);
  }

  async getAdminSearchHistory(limit: number = 50, offset: number = 0): Promise<{ history: SearchHistoryEntry[] }> {
    return this.request<{ history: SearchHistoryEntry[] }>(`/admin/search-history?limit=${limit}&offset=${offset}`);
  }

  async reindexPosts(): Promise<{ success: boolean; indexed_count: number }> {
    return this.request<{ success: boolean; indexed_count: number }>('/admin/reindex', { method: 'POST' });
  }

  async getAdminHealth(): Promise<{ status: string; postgres: boolean; elasticsearch: boolean; redis: boolean }> {
    return this.request('/admin/health');
  }
}

export const api = new ApiClient();
