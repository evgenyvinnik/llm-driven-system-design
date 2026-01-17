const API_BASE = '/api';

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

// Auth API
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

// Quotes API
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

// Portfolio API
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

// Orders API
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

// Watchlists API
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
