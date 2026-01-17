const API_BASE = '/api';

async function fetchAPI<T>(
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

// Auth API
export const authAPI = {
  login: (email: string, password: string) =>
    fetchAPI<{ user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (data: { email: string; password: string; name: string; phone?: string; role?: string }) =>
    fetchAPI<{ user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    fetchAPI<{ success: boolean }>('/auth/logout', {
      method: 'POST',
    }),

  getMe: () =>
    fetchAPI<{ user: import('../types').User }>('/auth/me'),

  becomeDriver: (vehicleType: string, licensePlate?: string) =>
    fetchAPI<{ driver: import('../types').Driver }>('/auth/become-driver', {
      method: 'POST',
      body: JSON.stringify({ vehicleType, licensePlate }),
    }),
};

// Restaurant API
export const restaurantAPI = {
  getAll: (params?: { cuisine?: string; search?: string; lat?: number; lon?: number; radius?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.cuisine) searchParams.set('cuisine', params.cuisine);
    if (params?.search) searchParams.set('search', params.search);
    if (params?.lat) searchParams.set('lat', params.lat.toString());
    if (params?.lon) searchParams.set('lon', params.lon.toString());
    if (params?.radius) searchParams.set('radius', params.radius.toString());
    const query = searchParams.toString();
    return fetchAPI<{ restaurants: import('../types').Restaurant[] }>(
      `/restaurants${query ? `?${query}` : ''}`
    );
  },

  getById: (id: number) =>
    fetchAPI<{ restaurant: import('../types').Restaurant; menu: import('../types').MenuByCategory }>(
      `/restaurants/${id}`
    ),

  getCuisines: () =>
    fetchAPI<{ cuisines: string[] }>('/restaurants/meta/cuisines'),

  getMyRestaurants: () =>
    fetchAPI<{ restaurants: import('../types').Restaurant[] }>('/restaurants/owner/my-restaurants'),

  create: (data: Partial<import('../types').Restaurant>) =>
    fetchAPI<{ restaurant: import('../types').Restaurant }>('/restaurants', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: number, data: Partial<import('../types').Restaurant>) =>
    fetchAPI<{ restaurant: import('../types').Restaurant }>(`/restaurants/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  addMenuItem: (restaurantId: number, item: Partial<import('../types').MenuItem>) =>
    fetchAPI<{ item: import('../types').MenuItem }>(`/restaurants/${restaurantId}/menu`, {
      method: 'POST',
      body: JSON.stringify(item),
    }),

  updateMenuItem: (restaurantId: number, itemId: number, data: Partial<import('../types').MenuItem>) =>
    fetchAPI<{ item: import('../types').MenuItem }>(`/restaurants/${restaurantId}/menu/${itemId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteMenuItem: (restaurantId: number, itemId: number) =>
    fetchAPI<{ success: boolean }>(`/restaurants/${restaurantId}/menu/${itemId}`, {
      method: 'DELETE',
    }),
};

// Order API
export const orderAPI = {
  create: (data: {
    restaurantId: number;
    items: Array<{ menuItemId: number; quantity: number; specialInstructions?: string }>;
    deliveryAddress: import('../types').DeliveryAddress;
    deliveryInstructions?: string;
    tip?: number;
  }) =>
    fetchAPI<{ order: import('../types').Order }>('/orders', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  getById: (id: number) =>
    fetchAPI<{ order: import('../types').Order }>(`/orders/${id}`),

  getMyOrders: (params?: { status?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());
    const query = searchParams.toString();
    return fetchAPI<{ orders: import('../types').Order[] }>(`/orders${query ? `?${query}` : ''}`);
  },

  updateStatus: (id: number, status: string, cancelReason?: string) =>
    fetchAPI<{ order: import('../types').Order; eta?: { eta: string; breakdown: import('../types').ETABreakdown } }>(
      `/orders/${id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status, cancelReason }),
      }
    ),

  getRestaurantOrders: (restaurantId: number, status?: string) => {
    const searchParams = new URLSearchParams();
    if (status) searchParams.set('status', status);
    const query = searchParams.toString();
    return fetchAPI<{ orders: import('../types').Order[] }>(
      `/orders/restaurant/${restaurantId}${query ? `?${query}` : ''}`
    );
  },
};

// Driver API
export const driverAPI = {
  updateLocation: (lat: number, lon: number) =>
    fetchAPI<{ success: boolean }>('/drivers/location', {
      method: 'POST',
      body: JSON.stringify({ lat, lon }),
    }),

  setStatus: (isActive: boolean) =>
    fetchAPI<{ isActive: boolean }>('/drivers/status', {
      method: 'POST',
      body: JSON.stringify({ isActive }),
    }),

  getOrders: (status?: string) => {
    const searchParams = new URLSearchParams();
    if (status) searchParams.set('status', status);
    const query = searchParams.toString();
    return fetchAPI<{ orders: import('../types').Order[] }>(`/drivers/orders${query ? `?${query}` : ''}`);
  },

  pickupOrder: (orderId: number) =>
    fetchAPI<{ order: import('../types').Order }>(`/drivers/orders/${orderId}/pickup`, {
      method: 'POST',
    }),

  deliverOrder: (orderId: number) =>
    fetchAPI<{ order: import('../types').Order }>(`/drivers/orders/${orderId}/deliver`, {
      method: 'POST',
    }),

  getStats: () =>
    fetchAPI<{
      driver: import('../types').Driver;
      today: { deliveries: number; tips: number; fees: number };
      activeOrders: number;
    }>('/drivers/stats'),
};
