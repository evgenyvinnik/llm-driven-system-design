const API_BASE = '/api/v1';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('auth_token');

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
    const error = await response.json().catch(() => ({ message: 'Request failed' }));
    throw new Error(error.message || `HTTP ${response.status}`);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return response.json();
}

// Admin API
export const adminApi = {
  login: (username: string, password: string) =>
    request<{ token: string; user: { id: string; username: string; role: string } }>(
      '/admin/login',
      { method: 'POST', body: JSON.stringify({ username, password }) }
    ),

  logout: () =>
    request<void>('/admin/logout', { method: 'POST' }),

  getMe: () =>
    request<{ id: string; username: string; role: string }>('/admin/me'),

  getStats: () =>
    request<{
      notifications: { total: number; pending: number; queued: number; delivered: number; failed: number; expired: number };
      devices: { total: number; valid: number; invalid: number };
      topics: { topic: string; subscriber_count: number }[];
      recent_notifications: Array<{
        id: string;
        device_id: string;
        status: string;
        created_at: string;
        payload: unknown;
      }>;
    }>('/admin/stats'),

  getDevices: (limit = 100, offset = 0) =>
    request<{ devices: Array<{
      device_id: string;
      token_hash: string;
      app_bundle_id: string;
      device_info: unknown;
      is_valid: boolean;
      created_at: string;
      last_seen: string;
    }>; total: number }>(`/admin/devices?limit=${limit}&offset=${offset}`),

  getNotifications: (limit = 100, offset = 0, status?: string) => {
    let url = `/admin/notifications?limit=${limit}&offset=${offset}`;
    if (status) url += `&status=${status}`;
    return request<{ notifications: Array<{
      id: string;
      device_id: string;
      status: string;
      priority: number;
      created_at: string;
      updated_at: string;
      payload: unknown;
    }>; total: number }>(url);
  },

  getFeedback: (limit = 100, offset = 0) =>
    request<{ feedback: Array<{
      id: number;
      token_hash: string;
      app_bundle_id: string;
      reason: string;
      timestamp: string;
    }>; total: number }>(`/admin/feedback?limit=${limit}&offset=${offset}`),

  broadcast: (payload: { aps: { alert?: string | { title?: string; body?: string }; badge?: number; sound?: string } }, priority = 10) =>
    request<{ total_devices: number; sent: number; failed: number }>(
      '/admin/broadcast',
      { method: 'POST', body: JSON.stringify({ payload, priority }) }
    ),

  cleanup: () =>
    request<{ cleaned: number }>('/admin/cleanup', { method: 'POST' }),
};

// Devices API
export const devicesApi = {
  register: (token: string, app_bundle_id: string, device_info?: unknown) =>
    request<{ device_id: string; is_new: boolean }>(
      '/devices/register',
      { method: 'POST', body: JSON.stringify({ token, app_bundle_id, device_info }) }
    ),

  getByToken: (token: string) =>
    request<{
      device_id: string;
      token_hash: string;
      app_bundle_id: string;
      is_valid: boolean;
      created_at: string;
      last_seen: string;
    }>(`/devices/token/${token}`),

  getById: (deviceId: string) =>
    request<{
      device_id: string;
      token_hash: string;
      app_bundle_id: string;
      is_valid: boolean;
      created_at: string;
      last_seen: string;
    }>(`/devices/${deviceId}`),

  invalidate: (token: string, reason?: string) =>
    request<void>(`/devices/token/${token}`, {
      method: 'DELETE',
      body: JSON.stringify({ reason }),
    }),

  subscribe: (device_token: string, topic: string) =>
    request<{ success: boolean; topic: string }>(
      '/devices/topics/subscribe',
      { method: 'POST', body: JSON.stringify({ device_token, topic }) }
    ),

  unsubscribe: (device_token: string, topic: string) =>
    request<{ success: boolean }>(
      '/devices/topics/unsubscribe',
      { method: 'POST', body: JSON.stringify({ device_token, topic }) }
    ),

  getTopics: (deviceId: string) =>
    request<{ device_id: string; topics: string[] }>(`/devices/${deviceId}/topics`),
};

// Notifications API
export const notificationsApi = {
  sendToDevice: (
    deviceToken: string,
    payload: { aps: { alert?: string | { title?: string; body?: string }; badge?: number; sound?: string } },
    options?: { priority?: number; expiration?: number; collapse_id?: string }
  ) =>
    request<{ notification_id: string; status: string }>(
      `/notifications/device/${deviceToken}`,
      { method: 'POST', body: JSON.stringify({ payload, ...options }) }
    ),

  sendToDeviceById: (
    deviceId: string,
    payload: { aps: { alert?: string | { title?: string; body?: string }; badge?: number; sound?: string } },
    options?: { priority?: number; expiration?: number; collapse_id?: string }
  ) =>
    request<{ notification_id: string; status: string }>(
      `/notifications/device-id/${deviceId}`,
      { method: 'POST', body: JSON.stringify({ payload, ...options }) }
    ),

  sendToTopic: (
    topic: string,
    payload: { aps: { alert?: string | { title?: string; body?: string }; badge?: number; sound?: string } },
    options?: { priority?: number; expiration?: number; collapse_id?: string }
  ) =>
    request<{ notification_id: string; status: string; queued_count?: number }>(
      `/notifications/topic/${topic}`,
      { method: 'POST', body: JSON.stringify({ payload, ...options }) }
    ),

  getById: (notificationId: string) =>
    request<{
      id: string;
      device_id: string;
      status: string;
      priority: number;
      created_at: string;
      updated_at: string;
      payload: unknown;
    }>(`/notifications/${notificationId}`),

  getStatus: (notificationId: string) =>
    request<{
      notification_id: string;
      status: string;
      created_at: string;
      updated_at: string;
    }>(`/notifications/${notificationId}/status`),
};

// Feedback API
export const feedbackApi = {
  getForApp: (appBundleId: string, since?: string) => {
    let url = `/feedback/${appBundleId}`;
    if (since) url += `?since=${since}`;
    return request<{ feedback: Array<{
      id: number;
      token_hash: string;
      reason: string;
      timestamp: string;
    }> }>(url);
  },

  clear: (appBundleId: string, before?: string) => {
    let url = `/feedback/${appBundleId}`;
    if (before) url += `?before=${before}`;
    return request<{ cleared: number }>(url, { method: 'DELETE' });
  },
};
