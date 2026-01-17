import type { ApiResponse, AuthResponse, User } from '@/types';

const API_BASE = '/api/v1';

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const token = localStorage.getItem('token');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }

  return data;
}

export const api = {
  // Auth
  async register(
    email: string,
    password: string,
    name: string,
    role: string,
    phone?: string,
    vehicleType?: string,
    licensePlate?: string
  ): Promise<AuthResponse> {
    const res = await request<AuthResponse>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password,
        name,
        phone,
        role,
        vehicle_type: vehicleType,
        license_plate: licensePlate,
      }),
    });
    return res.data!;
  },

  async login(email: string, password: string): Promise<AuthResponse> {
    const res = await request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return res.data!;
  },

  async logout(): Promise<void> {
    await request('/auth/logout', { method: 'POST' });
  },

  async getMe(): Promise<User> {
    const res = await request<User>('/auth/me');
    return res.data!;
  },

  // Merchants
  async getMerchants(lat: number, lng: number, radius?: number, category?: string) {
    const params = new URLSearchParams({
      lat: lat.toString(),
      lng: lng.toString(),
    });
    if (radius) params.set('radius', radius.toString());
    if (category) params.set('category', category);

    const res = await request(`/merchants?${params}`);
    return res.data;
  },

  async getMerchant(id: string) {
    const res = await request(`/merchants/${id}`);
    return res.data;
  },

  async getMerchantMenu(id: string) {
    const res = await request(`/merchants/${id}/menu`);
    return res.data;
  },

  async getCategories() {
    const res = await request('/merchants/categories');
    return res.data;
  },

  async searchMerchants(query: string, lat?: number, lng?: number) {
    const params = new URLSearchParams({ q: query });
    if (lat !== undefined) params.set('lat', lat.toString());
    if (lng !== undefined) params.set('lng', lng.toString());

    const res = await request(`/merchants/search?${params}`);
    return res.data;
  },

  // Orders
  async createOrder(orderData: {
    merchant_id: string;
    delivery_address: string;
    delivery_lat: number;
    delivery_lng: number;
    delivery_instructions?: string;
    items: { menu_item_id: string; quantity: number; special_instructions?: string }[];
    tip?: number;
  }) {
    const res = await request('/orders', {
      method: 'POST',
      body: JSON.stringify(orderData),
    });
    return res.data;
  },

  async getOrders() {
    const res = await request('/orders');
    return res.data;
  },

  async getOrder(id: string) {
    const res = await request(`/orders/${id}`);
    return res.data;
  },

  async cancelOrder(id: string, reason?: string) {
    const res = await request(`/orders/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    return res.data;
  },

  async rateDriver(orderId: string, rating: number, comment?: string) {
    const res = await request(`/orders/${orderId}/rate/driver`, {
      method: 'POST',
      body: JSON.stringify({ rating, comment }),
    });
    return res.data;
  },

  async rateMerchant(orderId: string, rating: number, comment?: string) {
    const res = await request(`/orders/${orderId}/rate/merchant`, {
      method: 'POST',
      body: JSON.stringify({ rating, comment }),
    });
    return res.data;
  },

  // Driver
  async getDriverProfile() {
    const res = await request('/driver/profile');
    return res.data;
  },

  async goOnline(lat: number, lng: number) {
    const res = await request('/driver/go-online', {
      method: 'POST',
      body: JSON.stringify({ lat, lng }),
    });
    return res.data;
  },

  async goOffline() {
    const res = await request('/driver/go-offline', { method: 'POST' });
    return res.data;
  },

  async updateLocation(lat: number, lng: number, speed?: number, heading?: number) {
    const res = await request('/driver/location', {
      method: 'POST',
      body: JSON.stringify({ lat, lng, speed, heading }),
    });
    return res.data;
  },

  async getDriverOrders() {
    const res = await request('/driver/orders');
    return res.data;
  },

  async getPendingOffer() {
    const res = await request('/driver/offers/pending');
    return res.data;
  },

  async acceptOffer(offerId: string) {
    const res = await request(`/driver/offers/${offerId}/accept`, {
      method: 'POST',
    });
    return res.data;
  },

  async rejectOffer(offerId: string) {
    const res = await request(`/driver/offers/${offerId}/reject`, {
      method: 'POST',
    });
    return res.data;
  },

  async markPickedUp(orderId: string) {
    const res = await request(`/driver/orders/${orderId}/picked-up`, {
      method: 'POST',
    });
    return res.data;
  },

  async markInTransit(orderId: string) {
    const res = await request(`/driver/orders/${orderId}/in-transit`, {
      method: 'POST',
    });
    return res.data;
  },

  async markDelivered(orderId: string) {
    const res = await request(`/driver/orders/${orderId}/delivered`, {
      method: 'POST',
    });
    return res.data;
  },

  async getDriverStats() {
    const res = await request('/driver/stats');
    return res.data;
  },

  // Admin
  async getAdminStats() {
    const res = await request('/admin/stats');
    return res.data;
  },

  async getAdminOrders(limit?: number) {
    const params = limit ? `?limit=${limit}` : '';
    const res = await request(`/admin/orders${params}`);
    return res.data;
  },

  async getAdminDrivers() {
    const res = await request('/admin/drivers');
    return res.data;
  },

  async getAdminMerchants() {
    const res = await request('/admin/merchants');
    return res.data;
  },

  async getAdminCustomers() {
    const res = await request('/admin/customers');
    return res.data;
  },

  async getHourlyAnalytics() {
    const res = await request('/admin/analytics/hourly');
    return res.data;
  },

  async getDailyAnalytics(days?: number) {
    const params = days ? `?days=${days}` : '';
    const res = await request(`/admin/analytics/daily${params}`);
    return res.data;
  },
};
