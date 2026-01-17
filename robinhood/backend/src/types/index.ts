/**
 * Represents a registered user in the trading platform.
 * Stores authentication credentials, profile info, and account state.
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  account_status: 'active' | 'suspended' | 'closed';
  /** Available cash for purchasing securities */
  buying_power: number;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

/**
 * Represents a stock position owned by a user.
 * Tracks quantity held, cost basis for P&L calculations,
 * and reserved shares for pending sell orders.
 */
export interface Position {
  id: string;
  user_id: string;
  symbol: string;
  quantity: number;
  /** Average purchase price per share for gain/loss calculations */
  avg_cost_basis: number;
  /** Shares locked for pending sell orders to prevent overselling */
  reserved_quantity: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * Represents a buy or sell order placed by a user.
 * Supports market, limit, stop, and stop-limit order types
 * with various time-in-force options.
 */
export interface Order {
  id: string;
  user_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  order_type: 'market' | 'limit' | 'stop' | 'stop_limit';
  quantity: number;
  limit_price: number | null;
  stop_price: number | null;
  status: 'pending' | 'submitted' | 'filled' | 'partial' | 'cancelled' | 'rejected' | 'expired';
  filled_quantity: number;
  avg_fill_price: number | null;
  time_in_force: 'day' | 'gtc' | 'ioc' | 'fok';
  submitted_at: Date | null;
  filled_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  /** Optimistic locking version for concurrent order updates */
  version: number;
}

/**
 * Represents a single trade execution against an order.
 * Orders can have multiple executions for partial fills.
 */
export interface Execution {
  id: string;
  order_id: string;
  quantity: number;
  price: number;
  exchange: string;
  executed_at: Date;
}

/**
 * Represents a user-created watchlist for tracking stocks.
 */
export interface Watchlist {
  id: string;
  user_id: string;
  name: string;
  created_at: Date;
}

/**
 * Represents a stock symbol added to a watchlist.
 */
export interface WatchlistItem {
  id: string;
  watchlist_id: string;
  symbol: string;
  created_at: Date;
}

/**
 * Represents a user-configured price alert.
 * Triggers when the stock price crosses the target threshold.
 */
export interface PriceAlert {
  id: string;
  user_id: string;
  symbol: string;
  target_price: number;
  condition: 'above' | 'below';
  triggered: boolean;
  triggered_at: Date | null;
  created_at: Date;
}

/**
 * Represents a real-time stock quote with market data.
 * Updated continuously by the quote simulation service.
 */
export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  /** Price change from market open */
  change: number;
  /** Percentage change from market open */
  changePercent: number;
  timestamp: number;
}

/**
 * Represents an active user session for authentication.
 * Sessions are stored in the database and validated on each request.
 */
export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}
