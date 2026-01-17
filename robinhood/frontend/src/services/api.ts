/**
 * Frontend API service for communicating with the Robinhood backend.
 * Provides typed API clients for authentication, quotes, portfolio,
 * orders, and watchlists. Automatically handles auth token injection.
 */

/** Base URL for all API requests (proxied to backend in dev) */
const API_BASE = '/api';

/**
 * Generic request helper with auth token injection.
 * Automatically includes Bearer token from localStorage if available.
 * @param endpoint - API endpoint path (e.g., '/auth/login')
 * @param options - Fetch options (method, body, headers)
 * @returns Promise resolving to typed response data
 * @throws Error with message from API on non-2xx responses
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const token = localStorage.getItem('token');

  const headers: HeadersInit = {
    'Content-Type': 'application/json',
    ...options.headers,
  };

  if (token) {
    (headers as Record<string, string>)['Authorization'] = `Bearer ${token}`;
  }

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
 * Authentication API client.
 * Handles user login, registration, and logout.
 */
export const authApi = {
  login: (email: string, password: string) =>
    request<{ token: string; user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  register: (data: { email: string; password: string; firstName?: string; lastName?: string }) =>
    request<{ token: string; user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  logout: () =>
    request<{ message: string }>('/auth/logout', {
      method: 'POST',
    }),
};

/**
 * Stock quotes API client.
 * Provides real-time quote data and stock information.
 */
export const quotesApi = {
  getAll: () => request<import('../types').Quote[]>('/quotes'),

  getQuote: (symbol: string) =>
    request<import('../types').Quote & { name: string }>(`/quotes/${symbol}`),

  getBatch: (symbols: string[]) =>
    request<import('../types').Quote[]>(`/quotes/batch?symbols=${symbols.join(',')}`),

  getStocks: () => request<import('../types').Stock[]>('/quotes/stocks'),

  getStockDetails: (symbol: string) =>
    request<{
      symbol: string;
      name: string;
      quote: import('../types').Quote;
      marketCap: number;
      peRatio: number;
      week52High: number;
      week52Low: number;
      avgVolume: number;
      dividend: string | null;
      description: string;
    }>(`/quotes/${symbol}/details`),
};

/**
 * Portfolio API client.
 * Provides portfolio summary, positions, and account information.
 */
export const portfolioApi = {
  getPortfolio: () => request<import('../types').Portfolio>('/portfolio'),

  getPositions: () => request<import('../types').Position[]>('/portfolio/positions'),

  getPosition: (symbol: string) =>
    request<import('../types').Position>(`/portfolio/positions/${symbol}`),

  getAccount: () =>
    request<{
      id: string;
      email: string;
      firstName: string | null;
      lastName: string | null;
      accountStatus: string;
      buyingPower: number;
      portfolioValue: number;
      totalEquity: number;
    }>('/portfolio/account'),
};

/**
 * Orders API client.
 * Handles order placement, retrieval, and cancellation.
 */
export const ordersApi = {
  getOrders: (status?: string) =>
    request<import('../types').Order[]>(`/orders${status ? `?status=${status}` : ''}`),

  getOrder: (orderId: string) =>
    request<import('../types').Order>(`/orders/${orderId}`),

  placeOrder: (data: {
    symbol: string;
    side: 'buy' | 'sell';
    orderType: 'market' | 'limit' | 'stop' | 'stop_limit';
    quantity: number;
    limitPrice?: number;
    stopPrice?: number;
    timeInForce?: 'day' | 'gtc' | 'ioc' | 'fok';
  }) =>
    request<{ order: import('../types').Order; message: string }>('/orders', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  cancelOrder: (orderId: string) =>
    request<{ message: string; order: import('../types').Order }>(`/orders/${orderId}`, {
      method: 'DELETE',
    }),
};

/**
 * Watchlists and price alerts API client.
 * Manages user watchlists, watchlist items, and price alerts.
 */
export const watchlistsApi = {
  getWatchlists: () => request<import('../types').Watchlist[]>('/watchlists'),

  createWatchlist: (name: string) =>
    request<import('../types').Watchlist>('/watchlists', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),

  deleteWatchlist: (watchlistId: string) =>
    request<{ message: string }>(`/watchlists/${watchlistId}`, {
      method: 'DELETE',
    }),

  addToWatchlist: (watchlistId: string, symbol: string) =>
    request<import('../types').WatchlistItem>(`/watchlists/${watchlistId}/items`, {
      method: 'POST',
      body: JSON.stringify({ symbol }),
    }),

  removeFromWatchlist: (watchlistId: string, symbol: string) =>
    request<{ message: string }>(`/watchlists/${watchlistId}/items/${symbol}`, {
      method: 'DELETE',
    }),

  getAlerts: () => request<import('../types').PriceAlert[]>('/watchlists/alerts'),

  createAlert: (symbol: string, targetPrice: number, condition: 'above' | 'below') =>
    request<import('../types').PriceAlert>('/watchlists/alerts', {
      method: 'POST',
      body: JSON.stringify({ symbol, targetPrice, condition }),
    }),

  deleteAlert: (alertId: string) =>
    request<{ message: string }>(`/watchlists/alerts/${alertId}`, {
      method: 'DELETE',
    }),

  getTriggeredAlerts: () =>
    request<Array<{
      id: string;
      symbol: string;
      targetPrice: number;
      condition: string;
      currentPrice: number;
      triggeredAt: string;
    }>>('/watchlists/alerts/triggered'),

  clearTriggeredAlerts: () =>
    request<{ message: string }>('/watchlists/alerts/triggered', {
      method: 'DELETE',
    }),
};
