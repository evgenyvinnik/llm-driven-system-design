import type { ApiResponse, PaginatedResponse, User, Event, SectionAvailability, Reservation, Order, QueueStatus } from '../types';

const API_BASE = '/api/v1';

async function fetchApi<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const sessionId = localStorage.getItem('sessionId');

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...(sessionId ? { 'X-Session-Id': sessionId } : {}),
    ...options.headers,
  };

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
    credentials: 'include',
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

// Auth API
export const authApi = {
  register: async (email: string, password: string, name: string) => {
    return fetchApi<ApiResponse<User>>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    });
  },

  login: async (email: string, password: string) => {
    const response = await fetchApi<ApiResponse<{ user: User; sessionId: string }>>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    if (response.data?.sessionId) {
      localStorage.setItem('sessionId', response.data.sessionId);
    }
    return response;
  },

  logout: async () => {
    const response = await fetchApi<ApiResponse<null>>('/auth/logout', { method: 'POST' });
    localStorage.removeItem('sessionId');
    return response;
  },

  me: async () => {
    return fetchApi<ApiResponse<User>>('/auth/me');
  },
};

// Events API
export const eventsApi = {
  getAll: async (params?: { category?: string; status?: string; search?: string; page?: number; limit?: number }) => {
    const queryParams = new URLSearchParams();
    if (params?.category) queryParams.set('category', params.category);
    if (params?.status) queryParams.set('status', params.status);
    if (params?.search) queryParams.set('search', params.search);
    if (params?.page) queryParams.set('page', params.page.toString());
    if (params?.limit) queryParams.set('limit', params.limit.toString());

    const query = queryParams.toString();
    return fetchApi<PaginatedResponse<Event>>(`/events${query ? `?${query}` : ''}`);
  },

  getById: async (id: string) => {
    return fetchApi<ApiResponse<Event>>(`/events/${id}`);
  },
};

// Seats API
export const seatsApi = {
  getAvailability: async (eventId: string, section?: string) => {
    const query = section ? `?section=${section}` : '';
    return fetchApi<ApiResponse<SectionAvailability[]>>(`/seats/${eventId}/availability${query}`);
  },

  getSectionSeats: async (eventId: string, section: string) => {
    return fetchApi<ApiResponse<SectionAvailability['seats']>>(`/seats/${eventId}/sections/${encodeURIComponent(section)}`);
  },

  reserve: async (eventId: string, seatIds: string[]) => {
    return fetchApi<ApiResponse<{ seats: Reservation['seats']; expiresAt: string; totalPrice: number }>>(`/seats/${eventId}/reserve`, {
      method: 'POST',
      body: JSON.stringify({ seat_ids: seatIds }),
    });
  },

  release: async (eventId: string, seatIds: string[]) => {
    return fetchApi<ApiResponse<null>>(`/seats/${eventId}/release`, {
      method: 'POST',
      body: JSON.stringify({ seat_ids: seatIds }),
    });
  },

  getReservation: async () => {
    return fetchApi<ApiResponse<Reservation | null>>('/seats/reservation');
  },
};

// Queue API
export const queueApi = {
  join: async (eventId: string) => {
    return fetchApi<ApiResponse<QueueStatus>>(`/queue/${eventId}/join`, { method: 'POST' });
  },

  getStatus: async (eventId: string) => {
    return fetchApi<ApiResponse<QueueStatus>>(`/queue/${eventId}/status`);
  },

  leave: async (eventId: string) => {
    return fetchApi<ApiResponse<null>>(`/queue/${eventId}/leave`, { method: 'POST' });
  },

  getStats: async (eventId: string) => {
    return fetchApi<ApiResponse<{ queueLength: number; activeCount: number; estimatedWait: number }>>(`/queue/${eventId}/stats`);
  },
};

// Checkout API
export const checkoutApi = {
  checkout: async (paymentMethod: string) => {
    return fetchApi<ApiResponse<{ order: Order; message: string }>>('/checkout', {
      method: 'POST',
      body: JSON.stringify({ payment_method: paymentMethod }),
    });
  },

  getOrders: async () => {
    return fetchApi<ApiResponse<Order[]>>('/checkout/orders');
  },

  getOrder: async (orderId: string) => {
    return fetchApi<ApiResponse<{ order: Order; seats: { section: string; row: string; seat_number: string; price: number }[] }>>(`/checkout/orders/${orderId}`);
  },

  cancelOrder: async (orderId: string) => {
    return fetchApi<ApiResponse<null>>(`/checkout/orders/${orderId}/cancel`, { method: 'POST' });
  },
};
