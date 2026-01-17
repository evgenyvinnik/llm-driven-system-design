/**
 * Base URL for all API requests.
 * Proxied through Vite dev server to avoid CORS issues during development.
 */
const API_BASE = '/api';

/**
 * Generic HTTP request wrapper that handles authentication and error responses.
 * Automatically attaches JWT token from localStorage if available.
 * This centralizes API communication logic to ensure consistent error handling
 * and authentication across all endpoints.
 *
 * @template T - The expected response type
 * @param endpoint - API endpoint path (e.g., '/auth/login')
 * @param options - Standard fetch options (method, body, headers, etc.)
 * @returns Promise resolving to the parsed JSON response
 * @throws Error with message from API response or generic failure message
 */
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

/**
 * Centralized API client for the Uber clone frontend.
 * Organized by domain (auth, rides, driver) to mirror backend service structure.
 * All methods return promises and handle authentication automatically.
 */
export const api = {
  /**
   * Authentication endpoints for user registration and session management.
   * Supports both rider and driver registration flows with different data requirements.
   */
  auth: {
    /**
     * Register a new rider account.
     * @param data - Rider registration details including email, password, name, and optional phone
     * @returns User object and JWT token for immediate authentication
     */
    registerRider: (data: { email: string; password: string; name: string; phone?: string }) =>
      request<{ success: boolean; user: unknown; token: string }>('/auth/register/rider', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    /**
     * Register a new driver account with vehicle information.
     * Drivers require additional vehicle details for ride matching.
     * @param data - Driver registration details including email, password, name, phone, and vehicle info
     * @returns User object and JWT token for immediate authentication
     */
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

    /**
     * Authenticate user with email and password.
     * @param email - User's email address
     * @param password - User's password
     * @returns User object and JWT token on successful authentication
     */
    login: (email: string, password: string) =>
      request<{ success: boolean; user: unknown; token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      }),

    /**
     * Verify current session and retrieve user profile.
     * Used on app startup to restore authenticated state.
     * @returns Current user object if token is valid
     */
    me: () => request<{ user: unknown }>('/auth/me'),

    /**
     * End the current user session.
     * @returns Success confirmation
     */
    logout: () =>
      request<{ success: boolean }>('/auth/logout', {
        method: 'POST',
      }),
  },

  /**
   * Ride management endpoints for riders.
   * Handles the full ride lifecycle from estimation to completion.
   */
  rides: {
    /**
     * Get fare estimates for all vehicle types between two locations.
     * Includes surge pricing and ETA information.
     * @param pickupLat - Pickup latitude
     * @param pickupLng - Pickup longitude
     * @param dropoffLat - Dropoff latitude
     * @param dropoffLng - Dropoff longitude
     * @returns Array of fare estimates per vehicle type
     */
    estimate: (pickupLat: number, pickupLng: number, dropoffLat: number, dropoffLng: number) =>
      request<{ estimates: unknown[] }>('/rides/estimate', {
        method: 'POST',
        body: JSON.stringify({ pickupLat, pickupLng, dropoffLat, dropoffLng }),
      }),

    /**
     * Request a new ride. Triggers driver matching algorithm.
     * @param data - Ride request with pickup/dropoff coordinates and optional vehicle type
     * @returns Created ride object with initial status 'requested'
     */
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

    /**
     * Get details of a specific ride by ID.
     * @param rideId - Unique ride identifier
     * @returns Complete ride object with current status
     */
    get: (rideId: string) => request<unknown>(`/rides/${rideId}`),

    /**
     * Cancel an active ride request.
     * @param rideId - Unique ride identifier
     * @param reason - Optional cancellation reason for analytics
     * @returns Success confirmation
     */
    cancel: (rideId: string, reason?: string) =>
      request<{ success: boolean }>(`/rides/${rideId}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),

    /**
     * Rate a completed ride's driver.
     * @param rideId - Unique ride identifier
     * @param rating - Rating from 1 to 5 stars
     * @returns Success confirmation
     */
    rate: (rideId: string, rating: number) =>
      request<{ success: boolean }>(`/rides/${rideId}/rate`, {
        method: 'POST',
        body: JSON.stringify({ rating }),
      }),

    /**
     * Get paginated ride history for the current user.
     * @param limit - Maximum number of rides to return (default 20)
     * @param offset - Number of rides to skip for pagination (default 0)
     * @returns Array of past rides
     */
    history: (limit?: number, offset?: number) =>
      request<{ rides: unknown[] }>(`/rides?limit=${limit || 20}&offset=${offset || 0}`),

    /**
     * Find available drivers near a location.
     * Used to display drivers on map before requesting a ride.
     * @param lat - Search center latitude
     * @param lng - Search center longitude
     * @param radius - Search radius in kilometers (default 5)
     * @returns Array of nearby driver locations
     */
    nearbyDrivers: (lat: number, lng: number, radius?: number) =>
      request<{ drivers: unknown[] }>(`/rides/nearby/drivers?lat=${lat}&lng=${lng}&radius=${radius || 5}`),

    /**
     * Get current surge pricing information for a location.
     * Surge is calculated per geohash cell based on supply/demand ratio.
     * @param lat - Location latitude
     * @param lng - Location longitude
     * @returns Surge multiplier and demand/supply metrics
     */
    surgeInfo: (lat: number, lng: number) =>
      request<unknown>(`/rides/surge/info?lat=${lat}&lng=${lng}`),
  },

  /**
   * Driver-specific endpoints for managing availability and rides.
   * Drivers interact with the system differently than riders.
   */
  driver: {
    /**
     * Update driver's current GPS location.
     * Called periodically while driver is online.
     * @param lat - Current latitude
     * @param lng - Current longitude
     * @returns Success confirmation
     */
    updateLocation: (lat: number, lng: number) =>
      request<{ success: boolean }>('/driver/location', {
        method: 'POST',
        body: JSON.stringify({ lat, lng }),
      }),

    /**
     * Set driver status to online and available for ride requests.
     * Adds driver to Redis geo index for matching.
     * @param lat - Current latitude
     * @param lng - Current longitude
     * @returns Updated status confirmation
     */
    goOnline: (lat: number, lng: number) =>
      request<{ success: boolean; status: string }>('/driver/online', {
        method: 'POST',
        body: JSON.stringify({ lat, lng }),
      }),

    /**
     * Set driver status to offline.
     * Removes driver from matching pool.
     * @returns Updated status confirmation
     */
    goOffline: () =>
      request<{ success: boolean; status: string }>('/driver/offline', {
        method: 'POST',
      }),

    /**
     * Get current driver status including location and active ride.
     * @returns Driver status object
     */
    status: () => request<unknown>('/driver/status'),

    /**
     * Accept a ride offer.
     * Transitions ride status from 'requested' to 'matched'.
     * @param rideId - Unique ride identifier
     * @returns Updated ride object with driver assigned
     */
    acceptRide: (rideId: string) =>
      request<unknown>(`/driver/rides/${rideId}/accept`, {
        method: 'POST',
      }),

    /**
     * Decline a ride offer.
     * Ride will be offered to next eligible driver.
     * @param rideId - Unique ride identifier
     * @returns Success confirmation
     */
    declineRide: (rideId: string) =>
      request<{ success: boolean }>(`/driver/rides/${rideId}/decline`, {
        method: 'POST',
      }),

    /**
     * Signal arrival at pickup location.
     * Notifies rider that driver has arrived.
     * @param rideId - Unique ride identifier
     * @returns Success confirmation
     */
    arrivedAtPickup: (rideId: string) =>
      request<{ success: boolean }>(`/driver/rides/${rideId}/arrived`, {
        method: 'POST',
      }),

    /**
     * Start the ride after picking up rider.
     * Transitions status to 'picked_up'.
     * @param rideId - Unique ride identifier
     * @returns Success confirmation
     */
    startRide: (rideId: string) =>
      request<{ success: boolean }>(`/driver/rides/${rideId}/start`, {
        method: 'POST',
      }),

    /**
     * Complete the ride at dropoff location.
     * Calculates final fare and processes payment.
     * @param rideId - Unique ride identifier
     * @param finalDistanceMeters - Optional actual distance if different from estimate
     * @returns Completed ride with final fare
     */
    completeRide: (rideId: string, finalDistanceMeters?: number) =>
      request<unknown>(`/driver/rides/${rideId}/complete`, {
        method: 'POST',
        body: JSON.stringify({ finalDistanceMeters }),
      }),

    /**
     * Get earnings summary for a time period.
     * @param period - Time period: 'today', 'week', or 'month'
     * @returns Earnings data with ride count and totals
     */
    earnings: (period?: string) =>
      request<unknown>(`/driver/earnings?period=${period || 'today'}`),

    /**
     * Get driver's profile including vehicle and rating information.
     * @returns Driver profile object
     */
    profile: () => request<unknown>('/driver/profile'),
  },
};

export default api;
