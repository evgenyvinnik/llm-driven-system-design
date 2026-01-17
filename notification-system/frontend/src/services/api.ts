const API_BASE = '/api/v1';

class ApiClient {
  private token: string | null = null;

  setToken(token: string | null) {
    this.token = token;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      ...options.headers,
    };

    if (this.token) {
      (headers as Record<string, string>)['Authorization'] = `Bearer ${this.token}`;
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
  async login(email: string, _password: string) {
    return this.request<{ token: string; user: { id: string; email: string; name: string; role: string } }>(
      '/auth/login',
      { method: 'POST', body: JSON.stringify({ email, password: _password }) }
    );
  }

  async register(email: string, name: string, phone?: string) {
    return this.request<{ token: string; user: { id: string; email: string; name: string; role: string } }>(
      '/auth/register',
      { method: 'POST', body: JSON.stringify({ email, name, phone }) }
    );
  }

  async logout() {
    return this.request<{ message: string }>('/auth/logout', { method: 'POST' });
  }

  async getMe() {
    return this.request<{ id: string; email: string; name: string; role: string }>('/auth/me');
  }

  // Notifications
  async sendNotification(data: {
    userId?: string;
    templateId?: string;
    data?: Record<string, unknown>;
    channels?: string[];
    priority?: string;
  }) {
    return this.request<{ notificationId: string; status: string; channels?: string[] }>(
      '/notifications',
      { method: 'POST', body: JSON.stringify(data) }
    );
  }

  async getNotifications(options?: { limit?: number; offset?: number; status?: string }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    if (options?.status) params.set('status', options.status);
    return this.request<{ notifications: unknown[] }>(`/notifications?${params}`);
  }

  async getNotification(id: string) {
    return this.request<unknown>(`/notifications/${id}`);
  }

  async cancelNotification(id: string) {
    return this.request<{ message: string }>(`/notifications/${id}`, { method: 'DELETE' });
  }

  async getRateLimitUsage() {
    return this.request<{ usage: Record<string, { used: number; limit: number; remaining: number }> }>(
      '/notifications/rate-limit/usage'
    );
  }

  async trackEvent(notificationId: string, eventType: string, channel: string) {
    return this.request<{ message: string }>(
      `/notifications/${notificationId}/events`,
      { method: 'POST', body: JSON.stringify({ eventType, channel }) }
    );
  }

  // Preferences
  async getPreferences() {
    return this.request<{
      channels: { push: { enabled: boolean }; email: { enabled: boolean }; sms: { enabled: boolean } };
      categories: Record<string, boolean>;
      quietHoursStart: number | null;
      quietHoursEnd: number | null;
      timezone: string;
    }>('/preferences');
  }

  async updatePreferences(updates: Record<string, unknown>) {
    return this.request<unknown>('/preferences', { method: 'PATCH', body: JSON.stringify(updates) });
  }

  async setQuietHours(start: string | null, end: string | null, enabled: boolean) {
    return this.request<unknown>(
      '/preferences/quiet-hours',
      { method: 'PUT', body: JSON.stringify({ start, end, enabled }) }
    );
  }

  // Templates
  async getTemplates() {
    return this.request<{ templates: unknown[] }>('/templates');
  }

  async getTemplate(id: string) {
    return this.request<unknown>(`/templates/${id}`);
  }

  async createTemplate(data: {
    id: string;
    name: string;
    description?: string;
    channels: Record<string, unknown>;
    variables?: string[];
  }) {
    return this.request<unknown>('/templates', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateTemplate(id: string, data: Record<string, unknown>) {
    return this.request<unknown>(`/templates/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async deleteTemplate(id: string) {
    return this.request<{ message: string }>(`/templates/${id}`, { method: 'DELETE' });
  }

  async previewTemplate(id: string, channel: string, data: Record<string, unknown>) {
    return this.request<{ rendered: Record<string, string> }>(
      `/templates/${id}/preview`,
      { method: 'POST', body: JSON.stringify({ channel, data }) }
    );
  }

  // Campaigns
  async getCampaigns(options?: { status?: string; limit?: number; offset?: number }) {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    return this.request<{ campaigns: unknown[] }>(`/campaigns?${params}`);
  }

  async getCampaign(id: string) {
    return this.request<unknown>(`/campaigns/${id}`);
  }

  async createCampaign(data: {
    name: string;
    description?: string;
    templateId?: string;
    targetAudience?: Record<string, unknown>;
    channels?: string[];
    priority?: string;
    scheduledAt?: string;
  }) {
    return this.request<unknown>('/campaigns', { method: 'POST', body: JSON.stringify(data) });
  }

  async updateCampaign(id: string, data: Record<string, unknown>) {
    return this.request<unknown>(`/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(data) });
  }

  async startCampaign(id: string) {
    return this.request<{ message: string; sentCount: number }>(`/campaigns/${id}/start`, { method: 'POST' });
  }

  async cancelCampaign(id: string) {
    return this.request<{ message: string }>(`/campaigns/${id}/cancel`, { method: 'POST' });
  }

  async deleteCampaign(id: string) {
    return this.request<{ message: string }>(`/campaigns/${id}`, { method: 'DELETE' });
  }

  // Admin
  async getAdminStats(timeRange?: string) {
    const params = timeRange ? `?timeRange=${encodeURIComponent(timeRange)}` : '';
    return this.request<{
      notifications: { total: number; delivered: number; pending: number; failed: number };
      deliveryByChannel: Record<string, Record<string, number>>;
      users: { total_users: number; new_users: number };
      queueDepth: Record<string, Record<string, number>>;
      timeRange: string;
    }>(`/admin/stats${params}`);
  }

  async getAdminUsers(options?: { limit?: number; offset?: number; role?: string }) {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    if (options?.role) params.set('role', options.role);
    return this.request<{ users: unknown[] }>(`/admin/users?${params}`);
  }

  async getAdminUser(id: string) {
    return this.request<unknown>(`/admin/users/${id}`);
  }

  async updateUserRole(id: string, role: string) {
    return this.request<unknown>(`/admin/users/${id}/role`, { method: 'PATCH', body: JSON.stringify({ role }) });
  }

  async resetUserRateLimit(id: string) {
    return this.request<{ message: string }>(`/admin/users/${id}/reset-rate-limit`, { method: 'POST' });
  }

  async getNotificationAnalytics(days?: number) {
    const params = days ? `?days=${days}` : '';
    return this.request<{ analytics: unknown[] }>(`/admin/analytics/notifications${params}`);
  }

  async getEventAnalytics(days?: number) {
    const params = days ? `?days=${days}` : '';
    return this.request<{ analytics: unknown[] }>(`/admin/analytics/events${params}`);
  }

  async getFailedNotifications() {
    return this.request<{ notifications: unknown[] }>('/admin/failed-notifications');
  }
}

export const api = new ApiClient();
