/**
 * Type definitions for the Price Tracking backend.
 * Defines database models, API request/response shapes, and internal types.
 * @module types
 */

/** Registered user in the system */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  email_notifications: boolean;
  created_at: Date;
  updated_at: Date;
}

/** Product being tracked for price changes */
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

/** User subscription to a product with alert settings */
export interface UserProduct {
  id: string;
  user_id: string;
  product_id: string;
  target_price: number | null;
  notify_any_drop: boolean;
  created_at: Date;
}

/** Historical price record for a product */
export interface PriceHistory {
  id: string;
  product_id: string;
  recorded_at: Date;
  price: number;
  currency: string;
  availability: boolean;
}

/** Price change notification sent to a user */
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

/** Domain-specific scraper configuration */
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

/** User authentication session */
export interface Session {
  id: string;
  user_id: string;
  token: string;
  expires_at: Date;
  created_at: Date;
}

/** Request body for adding a new product to track */
export interface CreateProductRequest {
  url: string;
  target_price?: number;
  notify_any_drop?: boolean;
}

/** Request body for updating product tracking settings */
export interface UpdateUserProductRequest {
  target_price?: number;
  notify_any_drop?: boolean;
}

/** Request body for user login */
export interface LoginRequest {
  email: string;
  password: string;
}

/** Request body for user registration */
export interface RegisterRequest {
  email: string;
  password: string;
}

/** Query parameters for price history retrieval */
export interface PriceHistoryParams {
  product_id: string;
  start_date?: Date;
  end_date?: Date;
  granularity?: 'hour' | 'day' | 'week';
}

/** Aggregated daily price statistics from TimescaleDB */
export interface DailyPriceSummary {
  day: Date;
  min_price: number;
  max_price: number;
  avg_price: number;
  data_points: number;
}

/** Product with user-specific subscription settings merged */
export interface ProductWithTracking extends Product {
  target_price?: number | null;
  notify_any_drop?: boolean;
  subscription_id?: string;
  watcher_count?: number;
}

/** Data extracted from a scraped product page */
export interface ScrapedData {
  price: number | null;
  title: string | null;
  image_url: string | null;
  availability: boolean;
  currency: string;
}

/** Scrape job queued for processing */
export interface ScrapeJob {
  product_id: string;
  url: string;
  domain: string;
  priority: number;
}
