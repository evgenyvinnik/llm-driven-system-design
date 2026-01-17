const API_BASE = '/api';

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    credentials: 'include',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

// Auth
export const authApi = {
  login: (email: string, password: string) =>
    fetchApi('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),
  register: (email: string, password: string, name: string) =>
    fetchApi('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),
  logout: () => fetchApi('/auth/logout', { method: 'POST' }),
  me: () => fetchApi('/auth/me'),
};

// Devices
export const devicesApi = {
  getAll: () => fetchApi('/devices'),
  get: (id: string) => fetchApi(`/devices/${id}`),
  create: (data: { device_type: string; name: string; emoji?: string }) =>
    fetchApi('/devices', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  update: (id: string, data: { name?: string; emoji?: string; is_active?: boolean }) =>
    fetchApi(`/devices/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    fetchApi(`/devices/${id}`, { method: 'DELETE' }),
  playSound: (id: string) =>
    fetchApi(`/devices/${id}/play-sound`, { method: 'POST' }),
};

// Locations
export const locationsApi = {
  getHistory: (deviceId: string, options?: { startTime?: number; endTime?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.startTime) params.set('startTime', options.startTime.toString());
    if (options?.endTime) params.set('endTime', options.endTime.toString());
    if (options?.limit) params.set('limit', options.limit.toString());
    return fetchApi(`/locations/${deviceId}?${params.toString()}`);
  },
  getLatest: (deviceId: string) => fetchApi(`/locations/${deviceId}/latest`),
  simulate: (deviceId: string, location: { latitude: number; longitude: number; accuracy?: number }) =>
    fetchApi(`/locations/${deviceId}/simulate`, {
      method: 'POST',
      body: JSON.stringify(location),
    }),
};

// Lost Mode
export const lostModeApi = {
  get: (deviceId: string) => fetchApi(`/lost-mode/${deviceId}`),
  update: (
    deviceId: string,
    data: {
      enabled: boolean;
      contact_phone?: string;
      contact_email?: string;
      message?: string;
      notify_when_found?: boolean;
    }
  ) =>
    fetchApi(`/lost-mode/${deviceId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  enable: (deviceId: string) =>
    fetchApi(`/lost-mode/${deviceId}/enable`, { method: 'POST' }),
  disable: (deviceId: string) =>
    fetchApi(`/lost-mode/${deviceId}/disable`, { method: 'POST' }),
};

// Notifications
export const notificationsApi = {
  getAll: (options?: { unreadOnly?: boolean; limit?: number }) => {
    const params = new URLSearchParams();
    if (options?.unreadOnly) params.set('unreadOnly', 'true');
    if (options?.limit) params.set('limit', options.limit.toString());
    return fetchApi(`/notifications?${params.toString()}`);
  },
  getUnreadCount: () => fetchApi('/notifications/unread-count'),
  markAsRead: (id: string) =>
    fetchApi(`/notifications/${id}/read`, { method: 'POST' }),
  markAllAsRead: () =>
    fetchApi('/notifications/read-all', { method: 'POST' }),
  delete: (id: string) =>
    fetchApi(`/notifications/${id}`, { method: 'DELETE' }),
};

// Anti-Stalking
export const antiStalkingApi = {
  recordSighting: (data: { identifier_hash: string; latitude: number; longitude: number }) =>
    fetchApi('/anti-stalking/sighting', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  getUnknownTrackers: () => fetchApi('/anti-stalking/unknown-trackers'),
  getSightings: (identifierHash: string) =>
    fetchApi(`/anti-stalking/sightings/${identifierHash}`),
};

// Admin
export const adminApi = {
  getStats: () => fetchApi('/admin/stats'),
  getUsers: () => fetchApi('/admin/users'),
  getDevices: () => fetchApi('/admin/devices'),
  getLostDevices: () => fetchApi('/admin/lost-devices'),
};
