/**
 * Core type definitions for the Robinhood trading frontend.
 * These types mirror the backend API responses and are used
 * throughout the application for type safety.
 */

/**
 * Real-time stock quote with price and change data.
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
  name?: string;
}

/**
 * Authenticated user information returned from login/register.
 */
export interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: 'user' | 'admin';
  buyingPower: number;
}

/**
 * Raw position data from the backend.
 */
export interface Position {
  id: string;
  user_id: string;
  symbol: string;
  quantity: number;
  avg_cost_basis: number;
  reserved_quantity: number;
  created_at: string;
  updated_at: string;
}

/**
 * A stock position held in the user's portfolio with calculated metrics.
 */
export interface PortfolioHolding {
  symbol: string;
  name: string;
  quantity: number;
  avgCostBasis: number;
  currentPrice: number;
  marketValue: number;
  gainLoss: number;
  gainLossPercent: number;
  dayChange: number;
  dayChangePercent: number;
}

/**
 * Complete portfolio summary with holdings and P&L metrics.
 */
export interface Portfolio {
  totalValue: number;
  totalCost: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  dayChange: number;
  dayChangePercent: number;
  buyingPower: number;
  holdings: PortfolioHolding[];
}

/**
 * A buy or sell order placed by the user.
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
  submitted_at: string | null;
  filled_at: string | null;
  cancelled_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * User-created watchlist containing stock symbols.
 */
export interface Watchlist {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  items: WatchlistItem[];
}

/**
 * A stock symbol in a watchlist with optional quote data.
 */
export interface WatchlistItem {
  id: string;
  watchlist_id: string;
  symbol: string;
  created_at: string;
  quote?: Quote;
}

/**
 * User-configured price alert.
 */
export interface PriceAlert {
  id: string;
  user_id: string;
  symbol: string;
  target_price: number;
  condition: 'above' | 'below';
  triggered: boolean;
  triggered_at: string | null;
  created_at: string;
}

/**
 * Stock information for display in lists.
 */
export interface Stock {
  symbol: string;
  name: string;
}
