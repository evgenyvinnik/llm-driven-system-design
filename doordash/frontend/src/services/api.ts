/**
 * Base URL for all API requests.
 * Uses a relative path to work with the Vite proxy in development
 * and the same-origin API in production.
 */
const API_BASE = '/api';

/**
 * Generic fetch wrapper for making typed API requests.
 * Provides consistent error handling, JSON parsing, and credential management
 * across all API calls in the application.
 *
 * @template T - The expected response type
 * @param endpoint - The API endpoint path (without the base URL)
 * @param options - Standard fetch options (method, body, headers, etc.)
 * @returns Promise resolving to the typed response data
 * @throws Error with the server error message or 'Request failed'
 */
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

/**
 * Authentication API endpoints.
 * Handles user login, registration, logout, and session management.
 * Uses session-based authentication with HTTP-only cookies.
 */
export const authAPI = {
  /**
   * Authenticates a user with email and password.
   * @param email - User's email address
   * @param password - User's password
   * @returns Promise with the authenticated user object
   */
  login: (email: string, password: string) =>
    fetchAPI<{ user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  /**
   * Registers a new user account.
   * @param data - Registration data including email, password, name, optional phone, and role
   * @returns Promise with the newly created user object
   */
  register: (data: { email: string; password: string; name: string; phone?: string; role?: string }) =>
    fetchAPI<{ user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /**
   * Logs out the current user by invalidating their session.
   * @returns Promise indicating logout success
   */
  logout: () =>
    fetchAPI<{ success: boolean }>('/auth/logout', {
      method: 'POST',
    }),

  /**
   * Fetches the currently authenticated user's profile.
   * Used to restore session state on page refresh.
   * @returns Promise with the current user object
   */
  getMe: () =>
    fetchAPI<{ user: import('../types').User }>('/auth/me'),

  /**
   * Upgrades a customer account to also be a driver.
   * @param vehicleType - Type of vehicle the driver will use
   * @param licensePlate - Optional license plate number
   * @returns Promise with the new driver profile
   */
  becomeDriver: (vehicleType: string, licensePlate?: string) =>
    fetchAPI<{ driver: import('../types').Driver }>('/auth/become-driver', {
      method: 'POST',
      body: JSON.stringify({ vehicleType, licensePlate }),
    }),
};

/**
 * Restaurant API endpoints.
 * Provides restaurant discovery, menu management, and restaurant owner operations.
 * Supports geolocation-based search for nearby restaurants.
 */
export const restaurantAPI = {
  /**
   * Fetches all restaurants with optional filtering.
   * @param params - Optional filter parameters (cuisine, search, location, radius)
   * @returns Promise with array of restaurants matching the criteria
   */
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

  /**
   * Fetches a single restaurant with its full menu organized by category.
   * @param id - Restaurant ID
   * @returns Promise with restaurant details and categorized menu
   */
  getById: (id: number) =>
    fetchAPI<{ restaurant: import('../types').Restaurant; menu: import('../types').MenuByCategory }>(
      `/restaurants/${id}`
    ),

  /**
   * Fetches all available cuisine types for filtering.
   * @returns Promise with array of cuisine type strings
   */
  getCuisines: () =>
    fetchAPI<{ cuisines: string[] }>('/restaurants/meta/cuisines'),

  /**
   * Fetches restaurants owned by the current user.
   * Used in the restaurant dashboard for owners.
   * @returns Promise with array of owned restaurants
   */
  getMyRestaurants: () =>
    fetchAPI<{ restaurants: import('../types').Restaurant[] }>('/restaurants/owner/my-restaurants'),

  /**
   * Creates a new restaurant for the current owner.
   * @param data - Restaurant creation data
   * @returns Promise with the newly created restaurant
   */
  create: (data: Partial<import('../types').Restaurant>) =>
    fetchAPI<{ restaurant: import('../types').Restaurant }>('/restaurants', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /**
   * Updates an existing restaurant's details.
   * @param id - Restaurant ID
   * @param data - Fields to update
   * @returns Promise with the updated restaurant
   */
  update: (id: number, data: Partial<import('../types').Restaurant>) =>
    fetchAPI<{ restaurant: import('../types').Restaurant }>(`/restaurants/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  /**
   * Adds a new menu item to a restaurant.
   * @param restaurantId - Restaurant ID
   * @param item - Menu item data
   * @returns Promise with the newly created menu item
   */
  addMenuItem: (restaurantId: number, item: Partial<import('../types').MenuItem>) =>
    fetchAPI<{ item: import('../types').MenuItem }>(`/restaurants/${restaurantId}/menu`, {
      method: 'POST',
      body: JSON.stringify(item),
    }),

  /**
   * Updates an existing menu item.
   * @param restaurantId - Restaurant ID
   * @param itemId - Menu item ID
   * @param data - Fields to update
   * @returns Promise with the updated menu item
   */
  updateMenuItem: (restaurantId: number, itemId: number, data: Partial<import('../types').MenuItem>) =>
    fetchAPI<{ item: import('../types').MenuItem }>(`/restaurants/${restaurantId}/menu/${itemId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  /**
   * Deletes a menu item from a restaurant.
   * @param restaurantId - Restaurant ID
   * @param itemId - Menu item ID to delete
   * @returns Promise indicating deletion success
   */
  deleteMenuItem: (restaurantId: number, itemId: number) =>
    fetchAPI<{ success: boolean }>(`/restaurants/${restaurantId}/menu/${itemId}`, {
      method: 'DELETE',
    }),
};

/**
 * Order API endpoints.
 * Manages the order lifecycle from placement through delivery.
 * Supports both customer and restaurant owner perspectives.
 */
export const orderAPI = {
  /**
   * Creates a new order from a customer's cart.
   * Initiates the order state machine and triggers driver matching.
   * @param data - Order details including restaurant, items, delivery info, and tip
   * @returns Promise with the newly created order
   */
  create: (data: {
    restaurantId: number;
    items: Array<{ menuItemId: number; quantity: number; specialInstructions?: string }>;
    deliveryAddress: import('../types').DeliveryAddress;
    deliveryInstructions?: string;
    tip?: number;
  }) =>
    fetchAPI<{ order: import('../types').Order }>('/orders', {
      method: 'POST',
      headers: { 'X-Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify(data),
    }),

  /**
   * Fetches a single order by ID with full details.
   * @param id - Order ID
   * @returns Promise with the complete order object
   */
  getById: (id: number) =>
    fetchAPI<{ order: import('../types').Order }>(`/orders/${id}`),

  /**
   * Fetches the current user's orders with optional filtering.
   * @param params - Optional filters for status and pagination
   * @returns Promise with array of user's orders
   */
  getMyOrders: (params?: { status?: string; limit?: number; offset?: number }) => {
    const searchParams = new URLSearchParams();
    if (params?.status) searchParams.set('status', params.status);
    if (params?.limit) searchParams.set('limit', params.limit.toString());
    if (params?.offset) searchParams.set('offset', params.offset.toString());
    const query = searchParams.toString();
    return fetchAPI<{ orders: import('../types').Order[] }>(`/orders${query ? `?${query}` : ''}`);
  },

  /**
   * Updates an order's status (state machine transition).
   * Used by restaurants, drivers, and for cancellation.
   * @param id - Order ID
   * @param status - New status to transition to
   * @param cancelReason - Optional reason if cancelling
   * @returns Promise with updated order and optional new ETA
   */
  updateStatus: (id: number, status: string, cancelReason?: string) =>
    fetchAPI<{ order: import('../types').Order; eta?: { eta: string; breakdown: import('../types').ETABreakdown } }>(
      `/orders/${id}/status`,
      {
        method: 'PATCH',
        body: JSON.stringify({ status, cancelReason }),
      }
    ),

  /**
   * Fetches orders for a specific restaurant.
   * Used in the restaurant owner dashboard.
   * @param restaurantId - Restaurant ID
   * @param status - Optional status filter (e.g., 'active')
   * @returns Promise with array of restaurant's orders
   */
  getRestaurantOrders: (restaurantId: number, status?: string) => {
    const searchParams = new URLSearchParams();
    if (status) searchParams.set('status', status);
    const query = searchParams.toString();
    return fetchAPI<{ orders: import('../types').Order[] }>(
      `/orders/restaurant/${restaurantId}${query ? `?${query}` : ''}`
    );
  },
};

/**
 * Driver API endpoints.
 * Manages driver operations including location tracking, availability, and deliveries.
 * Supports real-time location updates for accurate ETA calculations.
 */
export const driverAPI = {
  /**
   * Updates the driver's current GPS location.
   * Called periodically while the driver is online for ETA accuracy.
   * @param lat - Current latitude
   * @param lon - Current longitude
   * @returns Promise indicating update success
   */
  updateLocation: (lat: number, lon: number) =>
    fetchAPI<{ success: boolean }>('/drivers/location', {
      method: 'POST',
      body: JSON.stringify({ lat, lon }),
    }),

  /**
   * Sets the driver's availability status.
   * When active, the driver can receive new order assignments.
   * @param isActive - Whether the driver is available for orders
   * @returns Promise with the new active status
   */
  setStatus: (isActive: boolean) =>
    fetchAPI<{ isActive: boolean }>('/drivers/status', {
      method: 'POST',
      body: JSON.stringify({ isActive }),
    }),

  /**
   * Fetches orders assigned to the current driver.
   * @param status - Optional filter (e.g., 'active' for ongoing deliveries)
   * @returns Promise with array of driver's orders
   */
  getOrders: (status?: string) => {
    const searchParams = new URLSearchParams();
    if (status) searchParams.set('status', status);
    const query = searchParams.toString();
    return fetchAPI<{ orders: import('../types').Order[] }>(`/drivers/orders${query ? `?${query}` : ''}`);
  },

  /**
   * Confirms pickup of an order from the restaurant.
   * Transitions order status to PICKED_UP.
   * @param orderId - Order ID to pick up
   * @returns Promise with the updated order
   */
  pickupOrder: (orderId: number) =>
    fetchAPI<{ order: import('../types').Order }>(`/drivers/orders/${orderId}/pickup`, {
      method: 'POST',
    }),

  /**
   * Confirms delivery of an order to the customer.
   * Transitions order status to DELIVERED and completes the delivery.
   * @param orderId - Order ID to deliver
   * @returns Promise with the updated order
   */
  deliverOrder: (orderId: number) =>
    fetchAPI<{ order: import('../types').Order }>(`/drivers/orders/${orderId}/deliver`, {
      method: 'POST',
    }),

  /**
   * Fetches the driver's profile and daily statistics.
   * Used in the driver dashboard to show earnings and performance.
   * @returns Promise with driver profile, today's stats, and active order count
   */
  getStats: () =>
    fetchAPI<{
      driver: import('../types').Driver;
      today: { deliveries: number; tips: number; fees: number };
      activeOrders: number;
    }>('/drivers/stats'),
};
