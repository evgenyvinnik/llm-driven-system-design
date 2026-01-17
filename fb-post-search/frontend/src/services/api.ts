/**
 * @fileoverview API client for communicating with the backend.
 * Provides typed methods for all API endpoints with automatic token management.
 */

import type { User, SearchResponse, SearchFilters, SearchSuggestion, Post, AdminStats, SearchHistoryEntry } from '../types';

/**
 * Base URL for all API requests.
 * @constant
 */
const API_BASE = '/api/v1';

/**
 * API client class handling all HTTP requests to the backend.
 * Manages authentication tokens and provides typed methods for each endpoint.
 */
class ApiClient {
  private token: string | null = null;

  /**
   * Sets the authentication token and persists it to localStorage.
   * @param token - JWT token or null to clear authentication
   */
  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem('auth_token', token);
    } else {
      localStorage.removeItem('auth_token');
    }
  }

  /**
   * Retrieves the current authentication token from memory or localStorage.
   * @returns The stored token or null if not authenticated
   */
  getToken(): string | null {
    if (!this.token) {
      this.token = localStorage.getItem('auth_token');
    }
    return this.token;
  }

  /**
   * Makes an HTTP request to the API with automatic token injection.
   * @template T - Expected response type
   * @param endpoint - API endpoint path (without base URL)
   * @param options - Fetch options for the request
   * @returns Promise resolving to the typed response
   * @throws Error if the request fails or returns non-OK status
   */
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

  // === Authentication Methods ===

  /**
   * Authenticates a user with username and password.
   * @param username - User's username
   * @param password - User's password
   * @returns Promise resolving to token and user data
   */
  async login(username: string, password: string): Promise<{ token: string; user: User }> {
    const response = await this.request<{ token: string; user: User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    this.setToken(response.token);
    return response;
  }

  /**
   * Creates a new user account and automatically logs them in.
   * @param username - Unique username
   * @param email - User's email address
   * @param display_name - Display name for the user
   * @param password - Account password
   * @returns Promise resolving to token and user data
   */
  async register(username: string, email: string, display_name: string, password: string): Promise<{ token: string; user: User }> {
    const response = await this.request<{ token: string; user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, display_name, password }),
    });
    this.setToken(response.token);
    return response;
  }

  /**
   * Logs out the current user by invalidating their session.
   */
  async logout(): Promise<void> {
    await this.request('/auth/logout', { method: 'POST' }).catch(() => {});
    this.setToken(null);
  }

  /**
   * Retrieves the currently authenticated user's profile.
   * @returns Promise resolving to user data
   */
  async getCurrentUser(): Promise<User> {
    return this.request<User>('/auth/me');
  }

  // === Search Methods ===

  /**
   * Executes a search query with optional filters and pagination.
   * @param query - Search query text
   * @param filters - Optional filter criteria
   * @param cursor - Pagination cursor for next page
   * @param limit - Maximum results per page
   * @returns Promise resolving to search results
   */
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

  /**
   * Gets typeahead suggestions for a search prefix.
   * @param query - Partial search query
   * @param limit - Maximum suggestions to return
   * @returns Promise resolving to suggestions array
   */
  async getSuggestions(query: string, limit: number = 10): Promise<{ suggestions: SearchSuggestion[] }> {
    return this.request<{ suggestions: SearchSuggestion[] }>(
      `/search/suggestions?q=${encodeURIComponent(query)}&limit=${limit}`
    );
  }

  /**
   * Gets the most popular search queries.
   * @param limit - Maximum trending searches to return
   * @returns Promise resolving to trending search strings
   */
  async getTrending(limit: number = 10): Promise<{ trending: string[] }> {
    return this.request<{ trending: string[] }>(`/search/trending?limit=${limit}`);
  }

  /**
   * Gets the authenticated user's recent search queries.
   * @param limit - Maximum recent searches to return
   * @returns Promise resolving to recent search strings
   */
  async getRecentSearches(limit: number = 10): Promise<{ searches: string[] }> {
    return this.request<{ searches: string[] }>(`/search/recent?limit=${limit}`);
  }

  /**
   * Clears the authenticated user's search history.
   */
  async clearSearchHistory(): Promise<void> {
    await this.request('/search/history', { method: 'DELETE' });
  }

  // === Post Methods ===

  /**
   * Creates a new post.
   * @param content - Post content text
   * @param visibility - Visibility setting (default: 'friends')
   * @param post_type - Type of post (default: 'text')
   * @returns Promise resolving to the created post
   */
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

  /**
   * Gets the user's personalized feed of posts.
   * @param limit - Maximum posts to return
   * @param offset - Number of posts to skip
   * @returns Promise resolving to array of posts
   */
  async getFeed(limit: number = 20, offset: number = 0): Promise<{ posts: Post[] }> {
    return this.request<{ posts: Post[] }>(`/posts/feed?limit=${limit}&offset=${offset}`);
  }

  /**
   * Likes a post by incrementing its like count.
   * @param postId - ID of the post to like
   * @returns Promise resolving to the updated post
   */
  async likePost(postId: string): Promise<Post> {
    return this.request<Post>(`/posts/${postId}/like`, { method: 'POST' });
  }

  /**
   * Deletes a post.
   * @param postId - ID of the post to delete
   */
  async deletePost(postId: string): Promise<void> {
    await this.request(`/posts/${postId}`, { method: 'DELETE' });
  }

  // === Admin Methods ===

  /**
   * Gets system statistics for the admin dashboard.
   * @returns Promise resolving to admin stats
   */
  async getAdminStats(): Promise<AdminStats> {
    return this.request<AdminStats>('/admin/stats');
  }

  /**
   * Gets a paginated list of all users (admin only).
   * @param limit - Maximum users to return
   * @param offset - Number of users to skip
   * @returns Promise resolving to array of users
   */
  async getAdminUsers(limit: number = 50, offset: number = 0): Promise<{ users: User[] }> {
    return this.request<{ users: User[] }>(`/admin/users?limit=${limit}&offset=${offset}`);
  }

  /**
   * Gets a paginated list of all posts (admin only).
   * @param limit - Maximum posts to return
   * @param offset - Number of posts to skip
   * @returns Promise resolving to array of posts
   */
  async getAdminPosts(limit: number = 50, offset: number = 0): Promise<{ posts: Post[] }> {
    return this.request<{ posts: Post[] }>(`/admin/posts?limit=${limit}&offset=${offset}`);
  }

  /**
   * Gets search history for all users (admin only).
   * @param limit - Maximum entries to return
   * @param offset - Number of entries to skip
   * @returns Promise resolving to array of search history entries
   */
  async getAdminSearchHistory(limit: number = 50, offset: number = 0): Promise<{ history: SearchHistoryEntry[] }> {
    return this.request<{ history: SearchHistoryEntry[] }>(`/admin/search-history?limit=${limit}&offset=${offset}`);
  }

  /**
   * Triggers a full reindex of all posts in Elasticsearch (admin only).
   * @returns Promise resolving to success status and indexed count
   */
  async reindexPosts(): Promise<{ success: boolean; indexed_count: number }> {
    return this.request<{ success: boolean; indexed_count: number }>('/admin/reindex', { method: 'POST' });
  }

  /**
   * Gets system health status (admin only).
   * @returns Promise resolving to health status for each service
   */
  async getAdminHealth(): Promise<{ status: string; postgres: boolean; elasticsearch: boolean; redis: boolean }> {
    return this.request('/admin/health');
  }
}

/**
 * Singleton API client instance for use throughout the application.
 * @constant
 */
export const api = new ApiClient();
