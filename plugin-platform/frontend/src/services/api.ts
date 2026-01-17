// API service for the plugin marketplace

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// Types
export interface Plugin {
  id: string;
  name: string;
  description: string;
  category: string;
  author_name: string;
  license: string;
  install_count: number;
  avg_rating: number;
  review_count: number;
  latest_version: string;
  bundle_url: string;
  created_at: string;
  updated_at: string;
  tags?: string[];
}

export interface PluginDetails extends Plugin {
  homepage_url?: string;
  repository_url?: string;
  versions: PluginVersion[];
  reviews: PluginReview[];
}

export interface PluginVersion {
  version: string;
  bundle_url: string;
  changelog?: string;
  min_platform_version?: string;
  file_size: number;
  checksum: string;
  created_at: string;
}

export interface PluginReview {
  id: string;
  user_id: string;
  username: string;
  rating: number;
  title?: string;
  content?: string;
  created_at: string;
}

export interface InstalledPlugin {
  plugin_id: string;
  version_installed: string;
  is_enabled: boolean;
  installed_at: string;
  settings: Record<string, unknown>;
  plugin?: Plugin;
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

// Auth API
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

// Plugins API
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

// User Plugins API
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
