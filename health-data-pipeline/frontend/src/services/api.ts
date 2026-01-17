const API_BASE = '/api/v1';

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
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

export const api = {
  // Auth
  auth: {
    register: (email: string, password: string, name: string) =>
      request<{ user: import('../types').User; token: string }>('/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password, name }),
      }),

    login: (email: string, password: string) =>
      request<{ user: import('../types').User; token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),

    logout: () =>
      request<{ message: string }>('/auth/logout', { method: 'POST' }),

    me: () => request<{ user: import('../types').User }>('/auth/me'),
  },

  // Devices
  devices: {
    list: () => request<{ devices: import('../types').Device[] }>('/devices'),

    register: (deviceType: string, deviceName: string, deviceIdentifier: string) =>
      request<{ device: import('../types').Device }>('/devices', {
        method: 'POST',
        body: JSON.stringify({ deviceType, deviceName, deviceIdentifier }),
      }),

    sync: (deviceId: string, samples: Partial<import('../types').HealthSample>[]) =>
      request<{ synced: number; errors: number }>(`/devices/${deviceId}/sync`, {
        method: 'POST',
        body: JSON.stringify({ samples }),
      }),
  },

  // Health data
  health: {
    types: () => request<{ types: import('../types').HealthDataType[] }>('/health/types'),

    samples: (params: { type?: string; startDate?: string; endDate?: string }) => {
      const searchParams = new URLSearchParams();
      if (params.type) searchParams.set('type', params.type);
      if (params.startDate) searchParams.set('startDate', params.startDate);
      if (params.endDate) searchParams.set('endDate', params.endDate);
      return request<{ samples: import('../types').HealthSample[] }>(
        `/health/samples?${searchParams}`
      );
    },

    aggregates: (types: string[], period: string, startDate: string, endDate: string) => {
      const params = new URLSearchParams({
        types: types.join(','),
        period,
        startDate,
        endDate,
      });
      return request<{ aggregates: Record<string, import('../types').HealthAggregate[]> }>(
        `/health/aggregates?${params}`
      );
    },

    dailySummary: (date?: string) => {
      const params = date ? `?date=${date}` : '';
      return request<{ summary: import('../types').DailySummary; date: string }>(
        `/health/summary/daily${params}`
      );
    },

    weeklySummary: () =>
      request<{ summary: import('../types').WeeklySummary }>('/health/summary/weekly'),

    latest: () =>
      request<{ metrics: import('../types').LatestMetrics }>('/health/latest'),

    history: (type: string, days = 30) =>
      request<{ type: string; history: import('../types').HealthAggregate[] }>(
        `/health/history/${type}?days=${days}`
      ),

    insights: (limit = 10, unreadOnly = false) =>
      request<{ insights: import('../types').HealthInsight[] }>(
        `/health/insights?limit=${limit}&unreadOnly=${unreadOnly}`
      ),

    analyze: () =>
      request<{ insights: import('../types').HealthInsight[] }>('/health/insights/analyze', {
        method: 'POST',
      }),

    acknowledgeInsight: (insightId: string) =>
      request<{ message: string }>(`/health/insights/${insightId}/acknowledge`, {
        method: 'POST',
      }),
  },

  // Admin
  admin: {
    stats: () =>
      request<{
        totals: { users: number; samples: number; aggregates: number; insights: number; devices: number };
        samplesByType: { type: string; count: number }[];
        recentActivity: { hour: string; count: number }[];
      }>('/admin/stats'),

    users: (limit = 50, offset = 0) =>
      request<{ users: (import('../types').User & { device_count: number; metric_types: number })[] }>(
        `/admin/users?limit=${limit}&offset=${offset}`
      ),

    userDetails: (userId: string) =>
      request<{
        user: import('../types').User;
        devices: import('../types').Device[];
        sampleCounts: { type: string; count: number }[];
        recentInsights: import('../types').HealthInsight[];
      }>(`/admin/users/${userId}`),

    reaggregate: (userId: string, startDate?: string, endDate?: string) =>
      request<{ message: string }>(`/admin/users/${userId}/reaggregate`, {
        method: 'POST',
        body: JSON.stringify({ startDate, endDate }),
      }),
  },
};
