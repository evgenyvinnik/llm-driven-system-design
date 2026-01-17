const API_BASE = '/api';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('token');

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

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
    registerRider: (data: { email: string; password: string; name: string; phone?: string }) =>
      request<{ success: boolean; user: unknown; token: string }>('/auth/register/rider', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    registerDriver: (data: {
      email: string;
      password: string;
      name: string;
      phone?: string;
      vehicle: {
        vehicleType: string;
        vehicleMake: string;
        vehicleModel: string;
        vehicleColor: string;
        licensePlate: string;
      };
    }) =>
      request<{ success: boolean; user: unknown; token: string }>('/auth/register/driver', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    login: (email: string, password: string) =>
      request<{ success: boolean; user: unknown; token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),

    me: () => request<{ user: unknown }>('/auth/me'),

    logout: () =>
      request<{ success: boolean }>('/auth/logout', {
        method: 'POST',
      }),
  },

  // Rides
  rides: {
    estimate: (pickupLat: number, pickupLng: number, dropoffLat: number, dropoffLng: number) =>
      request<{ estimates: unknown[] }>('/rides/estimate', {
        method: 'POST',
        body: JSON.stringify({ pickupLat, pickupLng, dropoffLat, dropoffLng }),
      }),

    request: (data: {
      pickupLat: number;
      pickupLng: number;
      dropoffLat: number;
      dropoffLng: number;
      vehicleType?: string;
      pickupAddress?: string;
      dropoffAddress?: string;
    }) =>
      request<unknown>('/rides/request', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    get: (rideId: string) => request<unknown>(`/rides/${rideId}`),

    cancel: (rideId: string, reason?: string) =>
      request<{ success: boolean }>(`/rides/${rideId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),

    rate: (rideId: string, rating: number) =>
      request<{ success: boolean }>(`/rides/${rideId}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      }),

    history: (limit?: number, offset?: number) =>
      request<{ rides: unknown[] }>(`/rides?limit=${limit || 20}&offset=${offset || 0}`),

    nearbyDrivers: (lat: number, lng: number, radius?: number) =>
      request<{ drivers: unknown[] }>(`/rides/nearby/drivers?lat=${lat}&lng=${lng}&radius=${radius || 5}`),

    surgeInfo: (lat: number, lng: number) =>
      request<unknown>(`/rides/surge/info?lat=${lat}&lng=${lng}`),
  },

  // Driver
  driver: {
    updateLocation: (lat: number, lng: number) =>
      request<{ success: boolean }>('/driver/location', {
        method: 'POST',
        body: JSON.stringify({ lat, lng }),
      }),

    goOnline: (lat: number, lng: number) =>
      request<{ success: boolean; status: string }>('/driver/online', {
        method: 'POST',
        body: JSON.stringify({ lat, lng }),
      }),

    goOffline: () =>
      request<{ success: boolean; status: string }>('/driver/offline', {
        method: 'POST',
      }),

    status: () => request<unknown>('/driver/status'),

    acceptRide: (rideId: string) =>
      request<unknown>(`/driver/rides/${rideId}/accept`, {
        method: 'POST',
      }),

    declineRide: (rideId: string) =>
      request<{ success: boolean }>(`/driver/rides/${rideId}/decline`, {
        method: 'POST',
      }),

    arrivedAtPickup: (rideId: string) =>
      request<{ success: boolean }>(`/driver/rides/${rideId}/arrived`, {
        method: 'POST',
      }),

    startRide: (rideId: string) =>
      request<{ success: boolean }>(`/driver/rides/${rideId}/start`, {
        method: 'POST',
      }),

    completeRide: (rideId: string, finalDistanceMeters?: number) =>
      request<unknown>(`/driver/rides/${rideId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ finalDistanceMeters }),
      }),

    earnings: (period?: string) =>
      request<unknown>(`/driver/earnings?period=${period || 'today'}`),

    profile: () => request<unknown>('/driver/profile'),
  },
};

export default api;
