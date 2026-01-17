export interface User {
  id: string;
  email: string;
  password_hash: string;
  first_name: string | null;
  last_name: string | null;
  phone: string | null;
  account_status: 'active' | 'suspended' | 'closed';
  buying_power: number;
  role: 'user' | 'admin';
  created_at: Date;
  updated_at: Date;
}

export interface Position {
  id: string;
  user_id: string;
  symbol: string;
  quantity: number;
  avg_cost_basis: number;
  reserved_quantity: number;
  created_at: Date;
  updated_at: Date;
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
  submitted_at: Date | null;
  filled_at: Date | null;
  cancelled_at: Date | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

export interface Execution {
  id: string;
  order_id: string;
  quantity: number;
  price: number;
  exchange: string;
  executed_at: Date;
}

export interface Watchlist {
  id: string;
  user_id: string;
  name: string;
  created_at: Date;
}

export interface WatchlistItem {
  id: string;
  watchlist_id: string;
  symbol: string;
  created_at: Date;
}

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
}

export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}
