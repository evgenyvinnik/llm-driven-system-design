/**
 * Base URL for all API requests.
 * Uses relative path to work with the Vite proxy in development.
 */
const API_BASE = '/api';

/**
 * Handles API response parsing and error handling.
 * Provides consistent error extraction from JSON responses.
 *
 * @template T - The expected response body type
 * @param response - The fetch Response object
 * @returns Promise resolving to the parsed JSON body
 * @throws Error with message from API or generic failure message
 */
async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || 'Request failed');
  }
  return response.json();
}

/**
 * API client for the online auction system.
 * Provides methods for authentication, auction management, bidding,
 * notifications, and admin operations.
 *
 * All methods include credentials for session-based authentication
 * and use the handleResponse helper for consistent error handling.
 */
export const api = {
  // ============ Authentication ============

  /**
   * Registers a new user account.
   *
   * @param username - Display name for the user
   * @param email - Email address for login
   * @param password - Account password
   * @returns User data and session token
   */
  async register(username: string, email: string, password: string) {
    const response = await fetch(`${API_BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ username, email, password }),
    });
    return handleResponse<{ user: import('../types').User; token: string }>(response);
  },

  /**
   * Authenticates user with email and password.
   *
   * @param email - User's email address
   * @param password - User's password
   * @returns User data and session token
   */
  async login(email: string, password: string) {
    const response = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    });
    return handleResponse<{ user: import('../types').User; token: string }>(response);
  },

  /**
   * Logs out the current user and invalidates their session.
   *
   * @returns Confirmation message
   */
  async logout() {
    const response = await fetch(`${API_BASE}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  /**
   * Retrieves current authenticated user's profile.
   * Used to validate session on app load.
   *
   * @returns Current user data
   */
  async getMe() {
    const response = await fetch(`${API_BASE}/auth/me`, {
      credentials: 'include',
    });
    return handleResponse<{ user: import('../types').User }>(response);
  },

  // ============ Auctions ============

  /**
   * Fetches paginated list of auctions with optional filters.
   *
   * @param params - Optional filter and pagination parameters
   * @param params.status - Filter by auction status (active, ended, etc.)
   * @param params.sort - Field to sort by
   * @param params.order - Sort order (asc/desc)
   * @param params.page - Page number for pagination
   * @param params.limit - Items per page
   * @param params.search - Search term for title/description
   * @returns Paginated auction list
   */
  async getAuctions(params?: {
    status?: string;
    sort?: string;
    order?: string;
    page?: number;
    limit?: number;
    search?: string;
  }) {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) searchParams.set(key, String(value));
      });
    }
    const response = await fetch(`${API_BASE}/auctions?${searchParams}`, {
      credentials: 'include',
    });
    return handleResponse<import('../types').PaginatedResponse<import('../types').Auction>>(
      response
    );
  },

  /**
   * Fetches detailed information for a single auction.
   * Includes bid history, user's auto-bid settings, and watch status.
   *
   * @param id - Auction ID
   * @returns Full auction details with bids and user context
   */
  async getAuction(id: string) {
    const response = await fetch(`${API_BASE}/auctions/${id}`, {
      credentials: 'include',
    });
    return handleResponse<import('../types').AuctionDetail>(response);
  },

  /**
   * Creates a new auction listing.
   * Supports image upload via FormData.
   *
   * @param data - FormData containing auction details and optional image
   * @returns Created auction data
   */
  async createAuction(data: FormData) {
    const response = await fetch(`${API_BASE}/auctions`, {
      method: 'POST',
      credentials: 'include',
      body: data,
    });
    return handleResponse<{ auction: import('../types').Auction }>(response);
  },

  /**
   * Updates an existing auction (before bidding starts).
   *
   * @param id - Auction ID to update
   * @param data - FormData containing updated fields
   * @returns Updated auction data
   */
  async updateAuction(id: string, data: FormData) {
    const response = await fetch(`${API_BASE}/auctions/${id}`, {
      method: 'PUT',
      credentials: 'include',
      body: data,
    });
    return handleResponse<{ auction: import('../types').Auction }>(response);
  },

  async deleteAuction(id: string) {
    const response = await fetch(`${API_BASE}/auctions/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  async watchAuction(id: string) {
    const response = await fetch(`${API_BASE}/auctions/${id}/watch`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  async unwatchAuction(id: string) {
    const response = await fetch(`${API_BASE}/auctions/${id}/watch`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  async getWatchlist() {
    const response = await fetch(`${API_BASE}/auctions/user/watchlist`, {
      credentials: 'include',
    });
    return handleResponse<{ auctions: import('../types').Auction[] }>(response);
  },

  async getSellingAuctions() {
    const response = await fetch(`${API_BASE}/auctions/user/selling`, {
      credentials: 'include',
    });
    return handleResponse<{ auctions: import('../types').Auction[] }>(response);
  },

  async getBidHistory() {
    const response = await fetch(`${API_BASE}/auctions/user/bids`, {
      credentials: 'include',
    });
    return handleResponse<{ auctions: import('../types').Auction[] }>(response);
  },

  // Bids
  async placeBid(auctionId: string, amount: number) {
    const response = await fetch(`${API_BASE}/bids/${auctionId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ amount }),
    });
    return handleResponse<{
      bid: import('../types').Bid;
      current_price: number;
      is_winning: boolean;
    }>(response);
  },

  async setAutoBid(auctionId: string, maxAmount: number) {
    const response = await fetch(`${API_BASE}/bids/${auctionId}/auto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ max_amount: maxAmount }),
    });
    return handleResponse<{
      auto_bid: import('../types').AutoBid;
      current_price: number;
      is_winning: boolean;
    }>(response);
  },

  async cancelAutoBid(auctionId: string) {
    const response = await fetch(`${API_BASE}/bids/${auctionId}/auto`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  async getBids(auctionId: string) {
    const response = await fetch(`${API_BASE}/bids/${auctionId}`, {
      credentials: 'include',
    });
    return handleResponse<{ bids: import('../types').Bid[] }>(response);
  },

  // Notifications
  async getNotifications(unreadOnly = false) {
    const response = await fetch(
      `${API_BASE}/notifications?unread_only=${unreadOnly}`,
      {
        credentials: 'include',
      }
    );
    return handleResponse<{
      notifications: import('../types').Notification[];
      unread_count: number;
    }>(response);
  },

  async markNotificationRead(id: string) {
    const response = await fetch(`${API_BASE}/notifications/${id}/read`, {
      method: 'PUT',
      credentials: 'include',
    });
    return handleResponse<{ notification: import('../types').Notification }>(response);
  },

  async markAllNotificationsRead() {
    const response = await fetch(`${API_BASE}/notifications/read-all`, {
      method: 'PUT',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  // Admin
  async getAdminStats() {
    const response = await fetch(`${API_BASE}/admin/stats`, {
      credentials: 'include',
    });
    return handleResponse<{
      users: number;
      auctions: number;
      bids: number;
      activeAuctions: number;
      websocket: {
        connectedClients: number;
        totalSubscriptions: number;
        activeAuctions: number;
      };
    }>(response);
  },

  async getAdminUsers(params?: { page?: number; limit?: number; search?: string }) {
    const searchParams = new URLSearchParams();
    if (params) {
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined) searchParams.set(key, String(value));
      });
    }
    const response = await fetch(`${API_BASE}/admin/users?${searchParams}`, {
      credentials: 'include',
    });
    return handleResponse<{ users: import('../types').User[] }>(response);
  },

  async updateUserRole(userId: string, role: 'user' | 'admin') {
    const response = await fetch(`${API_BASE}/admin/users/${userId}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ role }),
    });
    return handleResponse<{ user: import('../types').User }>(response);
  },

  async forceCloseAuction(id: string) {
    const response = await fetch(`${API_BASE}/admin/auctions/${id}/close`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },
};
