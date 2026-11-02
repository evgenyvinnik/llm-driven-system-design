const API_BASE = '/api/v1';

/**
 * Performs an authenticated API request with JSON content type and credentials.
 * @param url - API endpoint path (appended to /api/v1).
 * @param options - Fetch request options.
 * @returns Parsed JSON response.
 */
async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${url}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: 'Request failed' }));
    throw new Error(error.error || `HTTP ${res.status}`);
  }

  return res.json();
}

// Auth
/** Authentication API methods for login, registration, logout, and session check. */
export const authApi = {
  login: (username: string, password: string) =>
    request<{ user: import('../types').User }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  register: (username: string, email: string, password: string, displayName?: string) =>
    request<{ user: import('../types').User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, email, password, displayName }),
    }),

  logout: () => request<{ message: string }>('/auth/logout', { method: 'POST' }),

  getMe: () => request<{ user: import('../types').User }>('/auth/me'),
};

// Markets
/** Markets API methods for trading pairs, prices, order books, candles, and trades. */
export const marketsApi = {
  getPairs: () =>
    request<{ pairs: import('../types').TradingPair[] }>('/markets/pairs'),

  getCurrencies: () =>
    request<{ currencies: import('../types').Currency[] }>('/markets/currencies'),

  getPrice: (symbol: string) =>
    request<import('../types').PriceData & { symbol: string }>(`/markets/${symbol}/price`),

  getOrderBook: (symbol: string, levels?: number) =>
    request<{
      symbol: string;
      bids: { price: number; quantity: number; orderCount: number }[];
      asks: { price: number; quantity: number; orderCount: number }[];
      spread: number | null;
      bestBid: number | null;
      bestAsk: number | null;
    }>(`/markets/${symbol}/orderbook?levels=${levels || 20}`),

  getCandles: (symbol: string, interval?: string, limit?: number) =>
    request<{ candles: import('../types').Candle[] }>(
      `/markets/${symbol}/candles?interval=${interval || '1m'}&limit=${limit || 100}`
    ),

  getTrades: (symbol: string, limit?: number) =>
    request<{
      trades: {
        id: string;
        price: string;
        quantity: string;
        createdAt: string;
        takerSide: string;
      }[];
    }>(`/markets/${symbol}/trades?limit=${limit || 50}`),
};

// Orders
/** Orders API methods for placing, cancelling, and listing orders. */
export const ordersApi = {
  placeOrder: (data: {
    tradingPairId: string;
    side: 'buy' | 'sell';
    orderType: 'market' | 'limit' | 'stop';
    quantity: string;
    price?: string;
    stopPrice?: string;
    idempotencyKey?: string;
  }) =>
    request<{ order: { id: string; status: string; filledQuantity: string; avgFillPrice: string | null } }>(
      '/orders',
      {
        method: 'POST',
        body: JSON.stringify(data),
      }
    ),

  cancelOrder: (id: string) =>
    request<{ message: string }>(`/orders/${id}`, { method: 'DELETE' }),

  getOrders: (status?: string, limit?: number) =>
    request<{ orders: import('../types').Order[] }>(
      `/orders?${status ? `status=${status}&` : ''}limit=${limit || 50}`
    ),
};

// Portfolio
/** Portfolio API methods for holdings summary and historical snapshots. */
export const portfolioApi = {
  getPortfolio: () =>
    request<{
      totalValueUsd: string;
      holdings: import('../types').PortfolioHolding[];
    }>('/portfolio'),

  getHistory: (limit?: number) =>
    request<{
      snapshots: {
        totalValueUsd: string;
        breakdown: Record<string, unknown>;
        createdAt: string;
      }[];
    }>(`/portfolio/history?limit=${limit || 100}`),
};

// Wallets
/** Wallets API methods for balance retrieval and deposit simulation. */
export const walletsApi = {
  getWallets: () =>
    request<{
      wallets: (import('../types').Wallet & { currencyId: string; valueUsd: string })[];
    }>('/wallets'),

  deposit: (currencyId: string, amount: string) =>
    request<{ message: string }>('/wallets/deposit', {
      method: 'POST',
      body: JSON.stringify({ currencyId, amount }),
    }),
};

// Transactions
/** Transactions API methods for retrieving trade and deposit history. */
export const transactionsApi = {
  getTransactions: (type?: string, limit?: number, offset?: number) =>
    request<{
      transactions: {
        id: string;
        type: string;
        currencyId: string;
        amount: string;
        fee: string;
        status: string;
        createdAt: string;
      }[];
      total: number;
    }>(
      `/transactions?${type ? `type=${type}&` : ''}limit=${limit || 50}&offset=${offset || 0}`
    ),
};

// Health
/** Health check API for service availability verification. */
export const healthApi = {
  check: () => request<{ status: string; timestamp: string; uptime: number }>('/health'),
};
