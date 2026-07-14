// API service for the plugin marketplace

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Types
//
// NOTE: these mirror the JSON the backend actually emits (see
// backend/src/api/routes/plugins.ts and user-plugins.ts). The API maps its
// snake_case SQL columns to camelCase before responding, so the client types
// must be camelCase too - reading `plugin.avg_rating` here silently yields
// `undefined` and the marketplace renders blank authors/ratings/install counts.
export interface PluginAuthor {
  username: string;
  displayName: string | null;
}

export interface Plugin {
  id: string;
  name: string;
  description: string;
  category: string;
  author: PluginAuthor;
  license: string;
  iconUrl?: string | null;
  isOfficial?: boolean;
  installCount: number;
  averageRating: number;
  reviewCount: number;
  latestVersion: string;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
}

export interface PluginDetails extends Plugin {
  homepageUrl?: string;
  repositoryUrl?: string;
  versions: PluginVersion[];
  reviews?: PluginReview[];
}

export interface PluginVersion {
  version: string;
  changelog?: string;
  publishedAt: string;
  fileSize: number;
}

export interface PluginReview {
  id: string;
  rating: number;
  title?: string;
  comment?: string;
  createdAt: string;
  author: PluginAuthor;
}

export interface InstalledPlugin {
  pluginId: string;
  version: string;
  enabled: boolean;
  installedAt: string;
  settings: Record<string, unknown>;
  name: string;
  description: string;
  category: string;
  iconUrl?: string | null;
  isOfficial?: boolean;
  manifest?: unknown;
  bundleUrl?: string;
}

export interface User {
  id: string;
  username: string;
  email: string;
  is_developer: boolean;
}

// API Response wrapper
interface ApiResponse<T> {
  data?: T;
  error?: string;
}

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  try {
    const res = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

    const data = await res.json();

    if (!res.ok) {
      return { error: data.error || 'Request failed' };
    }

    return { data };
  } catch (err) {
    return { error: err instanceof Error ? err.message : 'Network error' };
  }
}

/** Authentication API client for register, login, logout, and session checks. */
export const authApi = {
  async register(username: string, email: string, password: string) {
    return fetchApi<{ message: string; userId: string }>('/api/v1/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password }),
    });
  },

  async login(email: string, password: string) {
    return fetchApi<{ message: string; user: User }>('/api/v1/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
  },

  async logout() {
    return fetchApi<{ message: string }>('/api/v1/auth/logout', {
      method: 'POST',
    });
  },

  async getMe() {
    return fetchApi<{ user: User | null }>('/api/v1/auth/me');
  },
};

/** Plugin marketplace API client for listing, searching, and viewing plugin details. */
export const pluginsApi = {
  async list(params: {
    search?: string;
    category?: string;
    tag?: string;
    sort?: 'popular' | 'recent' | 'rating';
    page?: number;
    limit?: number;
  } = {}) {
    const searchParams = new URLSearchParams();
    if (params.search) searchParams.set('search', params.search);
    if (params.category) searchParams.set('category', params.category);
    if (params.tag) searchParams.set('tag', params.tag);
    if (params.sort) searchParams.set('sort', params.sort);
    if (params.page) searchParams.set('page', params.page.toString());
    if (params.limit) searchParams.set('limit', params.limit.toString());

    const query = searchParams.toString();
    return fetchApi<{
      plugins: Plugin[];
      total: number;
      page: number;
      totalPages: number;
    }>(`/api/v1/plugins${query ? `?${query}` : ''}`);
  },

  async getDetails(pluginId: string) {
    return fetchApi<{ plugin: PluginDetails }>(`/api/v1/plugins/${pluginId}`);
  },

  async getCategories() {
    return fetchApi<{ categories: { category: string; count: number }[] }>(
      '/api/v1/plugins/categories'
    );
  },
};

/** User plugin management API for installing, uninstalling, and configuring plugins. */
export const userPluginsApi = {
  async getInstalled() {
    return fetchApi<{ plugins: InstalledPlugin[] }>('/api/v1/user/plugins');
  },

  async install(pluginId: string, version?: string) {
    return fetchApi<{ message: string }>('/api/v1/user/plugins/install', {
      method: 'POST',
      body: JSON.stringify({ pluginId, version }),
    });
  },

  async uninstall(pluginId: string) {
    return fetchApi<{ message: string }>(`/api/v1/user/plugins/${pluginId}`, {
      method: 'DELETE',
    });
  },

  async toggleEnabled(pluginId: string, enabled: boolean) {
    return fetchApi<{ message: string }>(`/api/v1/user/plugins/${pluginId}/toggle`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    });
  },

  async updateSettings(pluginId: string, settings: Record<string, unknown>) {
    return fetchApi<{ message: string }>(`/api/v1/user/plugins/${pluginId}/settings`, {
      method: 'PUT',
      body: JSON.stringify({ settings }),
    });
  },
};
