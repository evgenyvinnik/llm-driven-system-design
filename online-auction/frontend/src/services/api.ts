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

  /**
   * Deletes an auction (only available before any bids are placed).
   *
   * @param id - Auction ID to delete
   * @returns Confirmation message
   */
  async deleteAuction(id: string) {
    const response = await fetch(`${API_BASE}/auctions/${id}`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  /**
   * Adds an auction to the user's watchlist.
   * Users receive notifications for watched auctions.
   *
   * @param id - Auction ID to watch
   * @returns Confirmation message
   */
  async watchAuction(id: string) {
    const response = await fetch(`${API_BASE}/auctions/${id}/watch`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  /**
   * Removes an auction from the user's watchlist.
   *
   * @param id - Auction ID to unwatch
   * @returns Confirmation message
   */
  async unwatchAuction(id: string) {
    const response = await fetch(`${API_BASE}/auctions/${id}/watch`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  /**
   * Retrieves all auctions in the user's watchlist.
   *
   * @returns List of watched auctions
   */
  async getWatchlist() {
    const response = await fetch(`${API_BASE}/auctions/user/watchlist`, {
      credentials: 'include',
    });
    return handleResponse<{ auctions: import('../types').Auction[] }>(response);
  },

  /**
   * Retrieves all auctions created by the current user.
   *
   * @returns List of user's auction listings
   */
  async getSellingAuctions() {
    const response = await fetch(`${API_BASE}/auctions/user/selling`, {
      credentials: 'include',
    });
    return handleResponse<{ auctions: import('../types').Auction[] }>(response);
  },

  /**
   * Retrieves auctions where the user has placed bids.
   *
   * @returns List of auctions with user's bid activity
   */
  async getBidHistory() {
    const response = await fetch(`${API_BASE}/auctions/user/bids`, {
      credentials: 'include',
    });
    return handleResponse<{ auctions: import('../types').Auction[] }>(response);
  },

  // ============ Bids ============

  /**
   * Places a manual bid on an auction.
   * The server serializes bids per auction with a row lock; the idempotency key
   * makes a retry of the same submitted bid safe (it replays, never re-bids).
   *
   * @param auctionId - Target auction ID
   * @param amount - Bid amount in dollars
   * @param idempotencyKey - One key per submitted bid, reused only when retrying it
   * @returns Bid result including new price and winning status
   */
  async placeBid(auctionId: string, amount: number, idempotencyKey?: string) {
    const response = await fetch(`${API_BASE}/bids/${auctionId}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ amount }),
    });
    return handleResponse<{
      bid: import('../types').Bid;
      current_price: number;
      is_winning: boolean;
    }>(response);
  },

  /**
   * Configures automatic bidding for an auction.
   * System will automatically outbid competitors up to the max amount.
   *
   * @param auctionId - Target auction ID
   * @param maxAmount - Maximum amount willing to bid
   * @param idempotencyKey - One key per submitted maximum, reused only when retrying it
   * @returns Auto-bid configuration and current status
   */
  async setAutoBid(auctionId: string, maxAmount: number, idempotencyKey?: string) {
    const response = await fetch(`${API_BASE}/bids/${auctionId}/auto`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      credentials: 'include',
      body: JSON.stringify({ max_amount: maxAmount }),
    });
    return handleResponse<{
      auto_bid: import('../types').AutoBid;
      current_price: number;
      is_winning: boolean;
    }>(response);
  },

  /**
   * Cancels automatic bidding for an auction.
   *
   * @param auctionId - Target auction ID
   * @returns Confirmation message
   */
  async cancelAutoBid(auctionId: string) {
    const response = await fetch(`${API_BASE}/bids/${auctionId}/auto`, {
      method: 'DELETE',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  /**
   * Retrieves bid history for an auction.
   *
   * @param auctionId - Target auction ID
   * @returns List of bids in chronological order
   */
  async getBids(auctionId: string) {
    const response = await fetch(`${API_BASE}/bids/${auctionId}`, {
      credentials: 'include',
    });
    return handleResponse<{ bids: import('../types').Bid[] }>(response);
  },

  // ============ Notifications ============

  /**
   * Retrieves user notifications (outbid, won, sold, etc.).
   *
   * @param unreadOnly - If true, only returns unread notifications
   * @returns Notification list and unread count
   */
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

  /**
   * Marks a single notification as read.
   *
   * @param id - Notification ID
   * @returns Updated notification
   */
  async markNotificationRead(id: string) {
    const response = await fetch(`${API_BASE}/notifications/${id}/read`, {
      method: 'PUT',
      credentials: 'include',
    });
    return handleResponse<{ notification: import('../types').Notification }>(response);
  },

  /**
   * Marks all notifications as read in bulk.
   *
   * @returns Confirmation message
   */
  async markAllNotificationsRead() {
    const response = await fetch(`${API_BASE}/notifications/read-all`, {
      method: 'PUT',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },

  // ============ Admin ============

  /**
   * Fetches platform-wide statistics for admin dashboard.
   * Includes user counts, auction stats, and WebSocket metrics.
   *
   * @returns Platform statistics
   */
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

  /**
   * Fetches paginated list of users for admin management.
   *
   * @param params - Optional pagination and search parameters
   * @param params.page - Page number
   * @param params.limit - Users per page
   * @param params.search - Search term for username/email
   * @returns List of users
   */
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

  /**
   * Updates a user's role (user or admin).
   * Admin-only operation.
   *
   * @param userId - Target user ID
   * @param role - New role to assign
   * @returns Updated user data
   */
  async updateUserRole(userId: string, role: 'user' | 'admin') {
    const response = await fetch(`${API_BASE}/admin/users/${userId}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ role }),
    });
    return handleResponse<{ user: import('../types').User }>(response);
  },

  /**
   * Forces an auction to close immediately.
   * Admin emergency action for problematic auctions.
   *
   * @param id - Auction ID to force close
   * @returns Confirmation message
   */
  async forceCloseAuction(id: string) {
    const response = await fetch(`${API_BASE}/admin/auctions/${id}/close`, {
      method: 'POST',
      credentials: 'include',
    });
    return handleResponse<{ message: string }>(response);
  },
};
