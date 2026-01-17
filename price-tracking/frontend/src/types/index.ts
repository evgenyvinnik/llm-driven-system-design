export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  email_notifications: boolean;
  created_at: string;
  updated_at: string;
}

export interface Product {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  image_url: string | null;
  current_price: number | null;
  currency: string;
  last_scraped: string | null;
  scrape_priority: number;
  status: 'active' | 'paused' | 'error' | 'unavailable';
  created_at: string;
  updated_at: string;
  target_price?: number | null;
  notify_any_drop?: boolean;
  subscription_id?: string;
  watcher_count?: number;
}

export interface PriceHistory {
  id: string;
  product_id: string;
  recorded_at: string;
  price: number;
  currency: string;
  availability: boolean;
}

export interface DailyPrice {
  day: string;
  min_price: number;
  max_price: number;
  avg_price: number;
  data_points: number;
}

export interface Alert {
  id: string;
  user_id: string;
  product_id: string;
  alert_type: 'target_reached' | 'price_drop' | 'back_in_stock';
  old_price: number | null;
  new_price: number;
  is_read: boolean;
  is_sent: boolean;
  created_at: string;
  product: Product;
}

export interface ApiError {
  error: string;
}

export interface AuthResponse {
  user: User;
  token: string;
}

export interface ProductsResponse {
  products: Product[];
}

export interface ProductResponse {
  product: Product;
}

export interface AlertsResponse {
  alerts: Alert[];
}

export interface PriceHistoryResponse {
  history: PriceHistory[];
}

export interface DailyPricesResponse {
  daily: DailyPrice[];
}

export interface AdminStats {
  users: number;
  products: number;
  alertsToday: number;
  pricePointsToday: number;
  productsByStatus: { status: string; count: number }[];
  recentScrapesByDomain: { domain: string; count: number }[];
}
