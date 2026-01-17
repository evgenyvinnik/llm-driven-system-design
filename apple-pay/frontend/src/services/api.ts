/**
 * API service for communicating with the Apple Pay backend.
 * Provides typed methods for all backend endpoints.
 * Automatically includes session and biometric headers when available.
 */

/** Base URL for API requests (proxied to backend in development) */
const API_BASE = '/api';

/**
 * Generic request helper that handles authentication headers and errors.
 * Automatically attaches X-Session-Id and X-Biometric-Session headers.
 *
 * @param endpoint - The API endpoint path (without /api prefix)
 * @param options - Fetch request options
 * @returns Promise resolving to the typed response body
 * @throws Error with message from API response or 'Network error'
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const sessionId = localStorage.getItem('sessionId');
  const biometricSession = sessionStorage.getItem('biometricSession');

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (sessionId) {
    headers['X-Session-Id'] = sessionId;
  }

  if (biometricSession) {
    headers['X-Biometric-Session'] = biometricSession;
  }

  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    headers,
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Network error' }));
    throw new Error(error.error || 'Request failed');
  }

  return response.json();
}

/**
 * API client object with methods for all backend endpoints.
 * Methods are grouped by resource: Auth, Devices, Cards, Payments, Merchants.
 */
export const api = {
  // ============ Auth ============

  /**
   * Authenticates a user with email and password.
   * @param email - User's email address
   * @param password - User's password
   * @param deviceId - Optional device ID for session binding
   * @returns Session ID and user details
   */
  login: (email: string, password: string, deviceId?: string) =>
    request<{ sessionId: string; user: any }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, deviceId }),
    }),

  /**
   * Creates a new user account.
   * @param email - User's email address
   * @param password - User's password
   * @param name - User's display name
   * @returns Created user details
   */
  register: (email: string, password: string, name: string) =>
    request<{ user: any }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),

  /** Logs out the current user by invalidating the session. */
  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),

  /** Retrieves the current authenticated user's profile. */
  getMe: () => request<{ user: any }>('/auth/me'),

  // ============ Devices ============

  /** Lists all devices registered to the current user. */
  getDevices: () => request<{ devices: any[] }>('/auth/devices'),

  /**
   * Registers a new device for the current user.
   * @param deviceName - Human-readable device name
   * @param deviceType - Device type (iphone, apple_watch, ipad)
   * @returns The newly registered device
   */
  registerDevice: (deviceName: string, deviceType: string) =>
    request<{ device: any }>('/auth/devices', {
      method: 'POST',
      body: JSON.stringify({ deviceName, deviceType }),
    }),

  /**
   * Removes a device and all its provisioned cards.
   * @param deviceId - The device's unique identifier
   */
  removeDevice: (deviceId: string) =>
    request<{ success: boolean }>(`/auth/devices/${deviceId}`, {
      method: 'DELETE',
    }),

  /**
   * Reports a device as lost, suspending all its cards.
   * @param deviceId - The device's unique identifier
   * @returns Count of suspended cards
   */
  reportDeviceLost: (deviceId: string) =>
    request<{ success: boolean; suspendedCards: number }>(
      `/auth/devices/${deviceId}/lost`,
      { method: 'POST' }
    ),

  // ============ Cards ============

  /** Lists all provisioned cards for the current user. */
  getCards: () => request<{ cards: any[] }>('/cards'),

  /**
   * Retrieves details of a specific card.
   * @param cardId - The card's unique identifier
   */
  getCard: (cardId: string) => request<{ card: any }>(`/cards/${cardId}`),

  /**
   * Provisions a new card to a device.
   * @param data - Card provisioning data (PAN, expiry, CVV, etc.)
   * @returns The newly provisioned card (without sensitive data)
   */
  provisionCard: (data: {
    pan: string;
    expiry_month: number;
    expiry_year: number;
    cvv: string;
    card_holder_name: string;
    device_id: string;
  }) =>
    request<{ card: any }>('/cards', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  /**
   * Suspends a card, preventing it from being used.
   * @param cardId - The card's unique identifier
   * @param reason - Optional reason for suspension
   */
  suspendCard: (cardId: string, reason?: string) =>
    request<{ success: boolean }>(`/cards/${cardId}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  /**
   * Reactivates a previously suspended card.
   * @param cardId - The card's unique identifier
   */
  reactivateCard: (cardId: string) =>
    request<{ success: boolean }>(`/cards/${cardId}/reactivate`, {
      method: 'POST',
    }),

  /**
   * Permanently removes a card from the wallet.
   * @param cardId - The card's unique identifier
   */
  removeCard: (cardId: string) =>
    request<{ success: boolean }>(`/cards/${cardId}`, { method: 'DELETE' }),

  /**
   * Sets a card as the default payment method.
   * @param cardId - The card's unique identifier
   */
  setDefaultCard: (cardId: string) =>
    request<{ success: boolean }>(`/cards/${cardId}/default`, {
      method: 'POST',
    }),

  // ============ Payments & Biometric ============

  /**
   * Initiates a biometric authentication session.
   * @param deviceId - The device performing auth
   * @param authType - Type of auth (face_id, touch_id, passcode)
   * @returns Session ID and challenge for the device to sign
   */
  initiateBiometric: (deviceId: string, authType: string) =>
    request<{ sessionId: string; challenge: string }>(
      '/payments/biometric/initiate',
      {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, auth_type: authType }),
      }
    ),

  /**
   * Verifies a biometric authentication response.
   * @param sessionId - The biometric session ID
   * @param response - The signed response from the device
   */
  verifyBiometric: (sessionId: string, response: string) =>
    request<{ success: boolean }>('/payments/biometric/verify', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, response }),
    }),

  /**
   * Simulates successful biometric authentication (demo only).
   * @param sessionId - The biometric session ID
   */
  simulateBiometric: (sessionId: string) =>
    request<{ success: boolean }>('/payments/biometric/simulate', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    }),

  /**
   * Processes a payment transaction.
   * Requires biometric session to be verified first.
   * @param data - Payment data (card, amount, merchant, etc.)
   * @returns Payment result with auth code or error
   */
  processPayment: (data: {
    card_id: string;
    amount: number;
    currency: string;
    merchant_id: string;
    transaction_type: string;
  }) =>
    request<{ success: boolean; transaction_id?: string; auth_code?: string; error?: string }>(
      '/payments/pay',
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    ),

  /**
   * Retrieves transaction history with optional filtering.
   * @param options - Pagination and filter options
   * @returns Array of transactions and total count
   */
  getTransactions: (options?: {
    limit?: number;
    offset?: number;
    card_id?: string;
    status?: string;
  }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', options.limit.toString());
    if (options?.offset) params.set('offset', options.offset.toString());
    if (options?.card_id) params.set('card_id', options.card_id);
    if (options?.status) params.set('status', options.status);
    return request<{ transactions: any[]; total: number }>(
      `/payments/transactions?${params}`
    );
  },

  /**
   * Retrieves details of a specific transaction.
   * @param transactionId - The transaction's unique identifier
   */
  getTransaction: (transactionId: string) =>
    request<{ transaction: any }>(`/payments/transactions/${transactionId}`),

  // ============ Merchants ============

  /** Lists all active merchants. */
  getMerchants: () => request<{ merchants: any[] }>('/merchants'),

  /**
   * Retrieves details of a specific merchant.
   * @param merchantId - The merchant's unique identifier
   */
  getMerchant: (merchantId: string) =>
    request<{ merchant: any }>(`/merchants/${merchantId}`),

  /**
   * Creates a payment session for in-app/web checkout.
   * @param merchantId - The merchant's unique identifier
   * @param amount - Payment amount
   * @param currency - Currency code (e.g., 'USD')
   * @returns Payment session for Apple Pay JS integration
   */
  createPaymentSession: (merchantId: string, amount: number, currency: string) =>
    request<{ session: any }>(`/merchants/${merchantId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ amount, currency }),
    }),
};

export default api;
