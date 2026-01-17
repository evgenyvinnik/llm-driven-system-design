const API_BASE = '/api';

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

export const api = {
  // Auth
  login: (email: string, password: string, deviceId?: string) =>
    request<{ sessionId: string; user: any }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password, deviceId }),
    }),

  register: (email: string, password: string, name: string) =>
    request<{ user: any }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ email, password, name }),
    }),

  logout: () =>
    request<{ success: boolean }>('/auth/logout', { method: 'POST' }),

  getMe: () => request<{ user: any }>('/auth/me'),

  // Devices
  getDevices: () => request<{ devices: any[] }>('/auth/devices'),

  registerDevice: (deviceName: string, deviceType: string) =>
    request<{ device: any }>('/auth/devices', {
      method: 'POST',
      body: JSON.stringify({ deviceName, deviceType }),
    }),

  removeDevice: (deviceId: string) =>
    request<{ success: boolean }>(`/auth/devices/${deviceId}`, {
      method: 'DELETE',
    }),

  reportDeviceLost: (deviceId: string) =>
    request<{ success: boolean; suspendedCards: number }>(
      `/auth/devices/${deviceId}/lost`,
      { method: 'POST' }
    ),

  // Cards
  getCards: () => request<{ cards: any[] }>('/cards'),

  getCard: (cardId: string) => request<{ card: any }>(`/cards/${cardId}`),

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

  suspendCard: (cardId: string, reason?: string) =>
    request<{ success: boolean }>(`/cards/${cardId}/suspend`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  reactivateCard: (cardId: string) =>
    request<{ success: boolean }>(`/cards/${cardId}/reactivate`, {
      method: 'POST',
    }),

  removeCard: (cardId: string) =>
    request<{ success: boolean }>(`/cards/${cardId}`, { method: 'DELETE' }),

  setDefaultCard: (cardId: string) =>
    request<{ success: boolean }>(`/cards/${cardId}/default`, {
      method: 'POST',
    }),

  // Payments & Biometric
  initiateBiometric: (deviceId: string, authType: string) =>
    request<{ sessionId: string; challenge: string }>(
      '/payments/biometric/initiate',
      {
        method: 'POST',
        body: JSON.stringify({ device_id: deviceId, auth_type: authType }),
      }
    ),

  verifyBiometric: (sessionId: string, response: string) =>
    request<{ success: boolean }>('/payments/biometric/verify', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId, response }),
    }),

  simulateBiometric: (sessionId: string) =>
    request<{ success: boolean }>('/payments/biometric/simulate', {
      method: 'POST',
      body: JSON.stringify({ session_id: sessionId }),
    }),

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

  getTransaction: (transactionId: string) =>
    request<{ transaction: any }>(`/payments/transactions/${transactionId}`),

  // Merchants
  getMerchants: () => request<{ merchants: any[] }>('/merchants'),

  getMerchant: (merchantId: string) =>
    request<{ merchant: any }>(`/merchants/${merchantId}`),

  createPaymentSession: (merchantId: string, amount: number, currency: string) =>
    request<{ session: any }>(`/merchants/${merchantId}/sessions`, {
      method: 'POST',
      body: JSON.stringify({ amount, currency }),
    }),
};

export default api;
