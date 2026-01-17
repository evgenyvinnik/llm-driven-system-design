/**
 * HTTP API client for the delivery platform.
 * Provides typed methods for all backend endpoints with automatic
 * authentication token handling and error processing.
 *
 * @module services/api
 */
import type { ApiResponse, AuthResponse, User } from '@/types';

/** Base URL for all API requests */
const API_BASE = '/api/v1';

/**
 * Generic request wrapper that handles authentication and JSON parsing.
 * Automatically attaches Bearer token from localStorage if available.
 *
 * @param endpoint - API endpoint path (without base URL)
 * @param options - Fetch options (method, body, headers, etc.)
 * @returns Parsed API response with typed data
 * @throws Error with message from API response if request fails
 */
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

/**
 * API client object with methods for all backend endpoints.
 * Organized by domain: auth, merchants, orders, driver, admin.
 */
export const api = {
  // ==================== Auth ====================

  /**
   * Registers a new user account.
   *
   * @param email - User's email address
   * @param password - User's password
   * @param name - User's display name
   * @param role - User role (customer, driver, merchant)
   * @param phone - Optional phone number
   * @param vehicleType - Required for drivers
   * @param licensePlate - Optional for drivers
   * @returns Authentication response with user and token
   */
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

  /**
   * Authenticates a user with email and password.
   *
   * @param email - User's email address
   * @param password - User's password
   * @returns Authentication response with user and token
   */
  async login(email: string, password: string): Promise<AuthResponse> {
    const res = await request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    return res.data!;
  },

  /**
   * Logs out the current user by invalidating their session.
   */
  async logout(): Promise<void> {
    await request('/auth/logout', { method: 'POST' });
  },

  /**
   * Fetches the currently authenticated user's profile.
   *
   * @returns Current user data
   */
  async getMe(): Promise<User> {
    const res = await request<User>('/auth/me');
    return res.data!;
  },

  // ==================== Merchants ====================

  /**
   * Fetches merchants near a given location.
   *
   * @param lat - Latitude of search center
   * @param lng - Longitude of search center
   * @param radius - Optional search radius in km
   * @param category - Optional category filter
   * @returns Array of nearby merchants with distances
   */
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

  /**
   * Fetches a single merchant by ID.
   *
   * @param id - Merchant UUID
   * @returns Merchant details
   */
  async getMerchant(id: string) {
    const res = await request(`/merchants/${id}`);
    return res.data;
  },

  /**
   * Fetches a merchant's menu items.
   *
   * @param id - Merchant UUID
   * @returns Array of menu items
   */
  async getMerchantMenu(id: string) {
    const res = await request(`/merchants/${id}/menu`);
    return res.data;
  },

  /**
   * Fetches all available merchant categories.
   *
   * @returns Array of category names
   */
  async getCategories() {
    const res = await request('/merchants/categories');
    return res.data;
  },

  /**
   * Searches for merchants by name, category, or description.
   *
   * @param query - Search term
   * @param lat - Optional latitude for distance calculation
   * @param lng - Optional longitude for distance calculation
   * @returns Array of matching merchants
   */
  async searchMerchants(query: string, lat?: number, lng?: number) {
    const params = new URLSearchParams({ q: query });
    if (lat !== undefined) params.set('lat', lat.toString());
    if (lng !== undefined) params.set('lng', lng.toString());

    const res = await request(`/merchants/search?${params}`);
    return res.data;
  },

  // ==================== Orders ====================

  /**
   * Creates a new order from the cart.
   *
   * @param orderData - Order details including items, address, and tip
   * @returns Created order with details
   */
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

  /**
   * Fetches all orders for the current customer.
   *
   * @returns Array of customer's orders
   */
  async getOrders() {
    const res = await request('/orders');
    return res.data;
  },

  /**
   * Fetches a single order with full details.
   *
   * @param id - Order UUID
   * @returns Order with items, merchant, and driver info
   */
  async getOrder(id: string) {
    const res = await request(`/orders/${id}`);
    return res.data;
  },

  /**
   * Cancels an order (if allowed by current status).
   *
   * @param id - Order UUID
   * @param reason - Optional cancellation reason
   * @returns Updated order
   */
  async cancelOrder(id: string, reason?: string) {
    const res = await request(`/orders/${id}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    });
    return res.data;
  },

  /**
   * Submits a rating for the driver on a completed order.
   *
   * @param orderId - Order UUID
   * @param rating - Rating value (1-5)
   * @param comment - Optional comment
   * @returns Created rating
   */
  async rateDriver(orderId: string, rating: number, comment?: string) {
    const res = await request(`/orders/${orderId}/rate/driver`, {
      method: 'POST',
      body: JSON.stringify({ rating, comment }),
    });
    return res.data;
  },

  /**
   * Submits a rating for the merchant on a completed order.
   *
   * @param orderId - Order UUID
   * @param rating - Rating value (1-5)
   * @param comment - Optional comment
   * @returns Created rating
   */
  async rateMerchant(orderId: string, rating: number, comment?: string) {
    const res = await request(`/orders/${orderId}/rate/merchant`, {
      method: 'POST',
      body: JSON.stringify({ rating, comment }),
    });
    return res.data;
  },

  // ==================== Driver ====================

  /**
   * Fetches the current driver's profile.
   *
   * @returns Driver profile data
   */
  async getDriverProfile() {
    const res = await request('/driver/profile');
    return res.data;
  },

  /**
   * Sets driver status to online and registers initial location.
   *
   * @param lat - Current latitude
   * @param lng - Current longitude
   * @returns Updated driver profile
   */
  async goOnline(lat: number, lng: number) {
    const res = await request('/driver/go-online', {
      method: 'POST',
      body: JSON.stringify({ lat, lng }),
    });
    return res.data;
  },

  /**
   * Sets driver status to offline.
   *
   * @returns Updated driver profile
   */
  async goOffline() {
    const res = await request('/driver/go-offline', { method: 'POST' });
    return res.data;
  },

  /**
   * Updates the driver's current location.
   *
   * @param lat - Current latitude
   * @param lng - Current longitude
   * @param speed - Optional current speed
   * @param heading - Optional heading direction
   * @returns Success acknowledgment
   */
  async updateLocation(lat: number, lng: number, speed?: number, heading?: number) {
    const res = await request('/driver/location', {
      method: 'POST',
      body: JSON.stringify({ lat, lng, speed, heading }),
    });
    return res.data;
  },

  /**
   * Fetches the driver's active orders.
   *
   * @returns Array of current orders
   */
  async getDriverOrders() {
    const res = await request('/driver/orders');
    return res.data;
  },

  /**
   * Fetches any pending delivery offer for the driver.
   *
   * @returns Pending offer or null
   */
  async getPendingOffer() {
    const res = await request('/driver/offers/pending');
    return res.data;
  },

  /**
   * Accepts a delivery offer.
   *
   * @param offerId - Offer UUID
   * @returns Assigned order
   */
  async acceptOffer(offerId: string) {
    const res = await request(`/driver/offers/${offerId}/accept`, {
      method: 'POST',
    });
    return res.data;
  },

  /**
   * Rejects a delivery offer.
   *
   * @param offerId - Offer UUID
   * @returns Success acknowledgment
   */
  async rejectOffer(offerId: string) {
    const res = await request(`/driver/offers/${offerId}/reject`, {
      method: 'POST',
    });
    return res.data;
  },

  /**
   * Marks an order as picked up from merchant.
   *
   * @param orderId - Order UUID
   * @returns Updated order
   */
  async markPickedUp(orderId: string) {
    const res = await request(`/driver/orders/${orderId}/picked-up`, {
      method: 'POST',
    });
    return res.data;
  },

  /**
   * Marks an order as in transit to customer.
   *
   * @param orderId - Order UUID
   * @returns Updated order
   */
  async markInTransit(orderId: string) {
    const res = await request(`/driver/orders/${orderId}/in-transit`, {
      method: 'POST',
    });
    return res.data;
  },

  /**
   * Marks an order as delivered to customer.
   *
   * @param orderId - Order UUID
   * @returns Updated order
   */
  async markDelivered(orderId: string) {
    const res = await request(`/driver/orders/${orderId}/delivered`, {
      method: 'POST',
    });
    return res.data;
  },

  /**
   * Fetches the driver's statistics (rating, deliveries, etc.).
   *
   * @returns Driver statistics
   */
  async getDriverStats() {
    const res = await request('/driver/stats');
    return res.data;
  },

  // ==================== Admin ====================

  /**
   * Fetches platform-wide statistics for admin dashboard.
   *
   * @returns Dashboard statistics
   */
  async getAdminStats() {
    const res = await request('/admin/stats');
    return res.data;
  },

  /**
   * Fetches recent orders for admin monitoring.
   *
   * @param limit - Optional max number of orders
   * @returns Array of recent orders
   */
  async getAdminOrders(limit?: number) {
    const params = limit ? `?limit=${limit}` : '';
    const res = await request(`/admin/orders${params}`);
    return res.data;
  },

  /**
   * Fetches all drivers for admin management.
   *
   * @returns Array of all drivers
   */
  async getAdminDrivers() {
    const res = await request('/admin/drivers');
    return res.data;
  },

  /**
   * Fetches all merchants for admin management.
   *
   * @returns Array of all merchants
   */
  async getAdminMerchants() {
    const res = await request('/admin/merchants');
    return res.data;
  },

  /**
   * Fetches all customers for admin management.
   *
   * @returns Array of all customers
   */
  async getAdminCustomers() {
    const res = await request('/admin/customers');
    return res.data;
  },

  /**
   * Fetches hourly order distribution for analytics.
   *
   * @returns Array of hourly counts
   */
  async getHourlyAnalytics() {
    const res = await request('/admin/analytics/hourly');
    return res.data;
  },

  /**
   * Fetches daily order trends for analytics.
   *
   * @param days - Optional number of days to include
   * @returns Array of daily statistics
   */
  async getDailyAnalytics(days?: number) {
    const params = days ? `?days=${days}` : '';
    const res = await request(`/admin/analytics/daily${params}`);
    return res.data;
  },
};
