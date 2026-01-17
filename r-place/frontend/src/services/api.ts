const API_BASE = '/api';

export async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'API request failed');
  }

  return data;
}

// Auth API
export const authApi = {
  login: (username: string, password: string) =>
    fetchApi<{ user: { id: string; username: string; role: string } }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (username: string, password: string) =>
    fetchApi<{ user: { id: string; username: string; role: string } }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  logout: () =>
    fetchApi<{ success: boolean }>('/auth/logout', {
      method: 'POST',
    }),

  me: () =>
    fetchApi<{ user: { id: string; username: string; role: string } }>('/auth/me'),

  anonymous: () =>
    fetchApi<{ user: { id: string; username: string; role: string } }>('/auth/anonymous', {
      method: 'POST',
    }),
};

// Canvas API
export const canvasApi = {
  getConfig: () =>
    fetchApi<{
      width: number;
      height: number;
      colors: string[];
      cooldownSeconds: number;
    }>('/canvas/config'),

  getCanvas: () =>
    fetchApi<{ canvas: string }>('/canvas'),

  placePixel: (x: number, y: number, color: number) =>
    fetchApi<{ success: boolean; nextPlacement?: number; error?: string }>(
      '/canvas/pixel',
      {
        method: 'POST',
        body: JSON.stringify({ x, y, color }),
      }
    ),

  getCooldown: () =>
    fetchApi<{
      canPlace: boolean;
      remainingSeconds: number;
      nextPlacement: number;
    }>('/canvas/cooldown'),

  getPixelHistory: (x: number, y: number) =>
    fetchApi<{
      history: Array<{
        x: number;
        y: number;
        color: number;
        userId: string;
        timestamp: number;
      }>;
    }>(`/canvas/pixel/${x}/${y}/history`),

  getRecentEvents: (limit = 100) =>
    fetchApi<{
      events: Array<{
        x: number;
        y: number;
        color: number;
        userId: string;
        timestamp: number;
      }>;
    }>(`/canvas/events?limit=${limit}`),
};
