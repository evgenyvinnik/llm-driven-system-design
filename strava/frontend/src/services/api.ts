const API_BASE = '/api';

async function request<T>(
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
export const auth = {
  login: (email: string, password: string) =>
    request<{ user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (data: { username: string; email: string; password: string }) =>
    request<{ user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', { method: 'POST' }),

  me: () =>
    request<{ user: import('../types').User }>('/auth/me'),
};

// Activities
export const activities = {
  list: (params?: { limit?: number; offset?: number; type?: string; userId?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.type) query.set('type', params.type);
    if (params?.userId) query.set('userId', params.userId);
    return request<{ activities: import('../types').Activity[] }>(`/activities?${query}`);
  },

  get: (id: string) =>
    request<import('../types').Activity>(`/activities/${id}`),

  getGps: (id: string) =>
    request<{ points: import('../types').GpsPoint[] }>(`/activities/${id}/gps`),

  upload: async (file: File, data: { type: string; name?: string; description?: string }) => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('type', data.type);
    if (data.name) formData.append('name', data.name);
    if (data.description) formData.append('description', data.description);

    const response = await fetch(`${API_BASE}/activities/upload`, {
      method: 'POST',
      body: formData,
      credentials: 'include',
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ error: 'Upload failed' }));
      throw new Error(error.error || 'Upload failed');
    }

    return response.json();
  },

  simulate: (data: { type?: string; name?: string; startLat?: number; startLng?: number; numPoints?: number }) =>
    request<{ activity: import('../types').Activity; gpsPointCount: number }>('/activities/simulate', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ message: string }>(`/activities/${id}`, { method: 'DELETE' }),

  kudos: (id: string) =>
    request<{ message: string }>(`/activities/${id}/kudos`, { method: 'POST' }),

  removeKudos: (id: string) =>
    request<{ message: string }>(`/activities/${id}/kudos`, { method: 'DELETE' }),

  getComments: (id: string) =>
    request<{ comments: import('../types').Comment[] }>(`/activities/${id}/comments`),

  addComment: (id: string, content: string) =>
    request<{ comment: import('../types').Comment }>(`/activities/${id}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
};

// Feed
export const feed = {
  get: (params?: { limit?: number; before?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.before) query.set('before', String(params.before));
    return request<{ activities: import('../types').Activity[] }>(`/feed?${query}`);
  },

  explore: (params?: { limit?: number; offset?: number; type?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.type) query.set('type', params.type);
    return request<{ activities: import('../types').Activity[] }>(`/feed/explore?${query}`);
  },
};

// Users
export const users = {
  get: (id: string) =>
    request<import('../types').User>(`/users/${id}`),

  search: (q: string) =>
    request<{ users: import('../types').User[] }>(`/users?q=${encodeURIComponent(q)}`),

  follow: (id: string) =>
    request<{ message: string }>(`/users/${id}/follow`, { method: 'POST' }),

  unfollow: (id: string) =>
    request<{ message: string }>(`/users/${id}/follow`, { method: 'DELETE' }),

  getFollowers: (id: string) =>
    request<{ followers: import('../types').User[] }>(`/users/${id}/followers`),

  getFollowing: (id: string) =>
    request<{ following: import('../types').User[] }>(`/users/${id}/following`),

  getAchievements: (id: string) =>
    request<{ achievements: import('../types').Achievement[] }>(`/users/${id}/achievements`),
};

// Segments
export const segments = {
  list: (params?: { limit?: number; offset?: number; type?: string; search?: string; lat?: number; lng?: number }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.offset) query.set('offset', String(params.offset));
    if (params?.type) query.set('type', params.type);
    if (params?.search) query.set('search', params.search);
    if (params?.lat) query.set('lat', String(params.lat));
    if (params?.lng) query.set('lng', String(params.lng));
    return request<{ segments: import('../types').Segment[] }>(`/segments?${query}`);
  },

  get: (id: string) =>
    request<import('../types').Segment>(`/segments/${id}`),

  getLeaderboard: (id: string, params?: { limit?: number; filter?: string }) => {
    const query = new URLSearchParams();
    if (params?.limit) query.set('limit', String(params.limit));
    if (params?.filter) query.set('filter', params.filter);
    return request<{ leaderboard: import('../types').LeaderboardEntry[] }>(`/segments/${id}/leaderboard?${query}`);
  },

  getEfforts: (id: string, userId?: string) => {
    const query = userId ? `?userId=${userId}` : '';
    return request<{ efforts: import('../types').SegmentEffort[] }>(`/segments/${id}/efforts${query}`);
  },

  create: (data: { activityId: string; startIndex: number; endIndex: number; name: string }) =>
    request<{ segment: import('../types').Segment }>('/segments', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  delete: (id: string) =>
    request<{ message: string }>(`/segments/${id}`, { method: 'DELETE' }),
};

// Stats
export const stats = {
  me: () =>
    request<import('../types').UserStats>('/stats/me'),

  records: () =>
    request<{
      longestByType: import('../types').Activity[];
      fastestByType: import('../types').Activity[];
      biggestClimb: import('../types').Activity | null;
      segmentPRs: import('../types').SegmentEffort[];
    }>('/stats/me/records'),

  adminOverview: () =>
    request<{
      users: { total_users: number; new_users_week: number; new_users_month: number };
      activities: { total_activities: number; activities_week: number; activities_today: number };
      typeDistribution: { type: string; count: number }[];
      segments: { total_segments: number; total_efforts: number };
      topActivities: import('../types').Activity[];
    }>('/stats/admin/overview'),
};
