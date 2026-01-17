import type {
  SuggestionsResponse,
  TrendingResponse,
  HistoryResponse,
  AnalyticsSummary,
  HourlyStats,
  TopPhrase,
  SystemStatus,
} from '../types';

const API_BASE = '/api/v1';

class ApiService {
  private async request<T>(endpoint: string, options?: RequestInit): Promise<T> {
    const response = await fetch(`${API_BASE}${endpoint}`, {
      headers: {
        'Content-Type': 'application/json',
      },
      ...options,
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: 'Unknown error' }));
      throw new Error(error.message || `HTTP ${response.status}`);
    }

    return response.json();
  }

  // Suggestions
  async getSuggestions(
    prefix: string,
    options: { limit?: number; userId?: string; fuzzy?: boolean } = {}
  ): Promise<SuggestionsResponse> {
    const params = new URLSearchParams({
      q: prefix,
      limit: String(options.limit || 5),
    });

    if (options.userId) {
      params.append('userId', options.userId);
    }

    if (options.fuzzy) {
      params.append('fuzzy', 'true');
    }

    return this.request<SuggestionsResponse>(`/suggestions?${params}`);
  }

  async logSearch(query: string, userId?: string, sessionId?: string): Promise<void> {
    await this.request('/suggestions/log', {
      method: 'POST',
      body: JSON.stringify({ query, userId, sessionId }),
    });
  }

  async getTrending(limit = 10): Promise<TrendingResponse> {
    return this.request<TrendingResponse>(`/suggestions/trending?limit=${limit}`);
  }

  async getHistory(userId: string, limit = 10): Promise<HistoryResponse> {
    return this.request<HistoryResponse>(`/suggestions/history?userId=${userId}&limit=${limit}`);
  }

  // Analytics
  async getAnalyticsSummary(): Promise<AnalyticsSummary> {
    return this.request<AnalyticsSummary>('/analytics/summary');
  }

  async getHourlyStats(): Promise<{ hourly: HourlyStats[] }> {
    return this.request<{ hourly: HourlyStats[] }>('/analytics/hourly');
  }

  async getTopPhrases(limit = 50): Promise<{ phrases: TopPhrase[]; meta: { count: number } }> {
    return this.request(`/analytics/top-phrases?limit=${limit}`);
  }

  // Admin
  async getSystemStatus(): Promise<SystemStatus> {
    return this.request<SystemStatus>('/admin/status');
  }

  async rebuildTrie(): Promise<{ success: boolean; message: string; stats: unknown }> {
    return this.request('/admin/trie/rebuild', { method: 'POST' });
  }

  async clearCache(): Promise<{ success: boolean; message: string }> {
    return this.request('/admin/cache/clear', { method: 'POST' });
  }

  async addPhrase(phrase: string, count = 1): Promise<{ success: boolean; phrase: string; count: number }> {
    return this.request('/admin/phrases', {
      method: 'POST',
      body: JSON.stringify({ phrase, count }),
    });
  }

  async filterPhrase(phrase: string, reason = 'manual'): Promise<{ success: boolean; phrase: string }> {
    return this.request('/admin/filter', {
      method: 'POST',
      body: JSON.stringify({ phrase, reason }),
    });
  }

  async getFilteredPhrases(limit = 100): Promise<{
    filtered: Array<{ phrase: string; reason: string; added_at: string }>;
    meta: { count: number };
  }> {
    return this.request(`/admin/filtered?limit=${limit}`);
  }
}

export const api = new ApiService();
