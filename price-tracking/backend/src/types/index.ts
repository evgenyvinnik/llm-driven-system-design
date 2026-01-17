export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  email_notifications: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Product {
  id: string;
  url: string;
  domain: string;
  title: string | null;
  image_url: string | null;
  current_price: number | null;
  currency: string;
  last_scraped: Date | null;
  scrape_priority: number;
  status: 'active' | 'paused' | 'error' | 'unavailable';
  created_at: Date;
  updated_at: Date;
}

export interface UserProduct {
  id: string;
  user_id: string;
  product_id: string;
  target_price: number | null;
  notify_any_drop: boolean;
  created_at: Date;
}

export interface PriceHistory {
  id: string;
  product_id: string;
  recorded_at: Date;
  price: number;
  currency: string;
  availability: boolean;
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
  created_at: Date;
}

export interface ScraperConfig {
  id: string;
  domain: string;
  price_selector: string | null;
  title_selector: string | null;
  image_selector: string | null;
  parser_type: 'css' | 'xpath' | 'json-ld' | 'custom';
  rate_limit: number;
  requires_js: boolean;
  is_active: boolean;
  last_validated: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

// API Request/Response types
export interface CreateProductRequest {
  url: string;
  target_price?: number;
  notify_any_drop?: boolean;
}

export interface UpdateUserProductRequest {
  target_price?: number;
  notify_any_drop?: boolean;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
}

export interface PriceHistoryParams {
  product_id: string;
  start_date?: Date;
  end_date?: Date;
  granularity?: 'hour' | 'day' | 'week';
}

export interface DailyPriceSummary {
  day: Date;
  min_price: number;
  max_price: number;
  avg_price: number;
  data_points: number;
}

export interface ProductWithTracking extends Product {
  target_price?: number | null;
  notify_any_drop?: boolean;
  subscription_id?: string;
  watcher_count?: number;
}

export interface ScrapedData {
  price: number | null;
  title: string | null;
  image_url: string | null;
  availability: boolean;
  currency: string;
}

export interface ScrapeJob {
  product_id: string;
  url: string;
  domain: string;
  priority: number;
}
