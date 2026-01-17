export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  change: number;
  changePercent: number;
  timestamp: number;
  name?: string;
}

export interface User {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  role: 'user' | 'admin';
  buyingPower: number;
}

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

export interface Watchlist {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  items: WatchlistItem[];
}

export interface WatchlistItem {
  id: string;
  watchlist_id: string;
  symbol: string;
  created_at: string;
  quote?: Quote;
}

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

export interface Stock {
  symbol: string;
  name: string;
}
