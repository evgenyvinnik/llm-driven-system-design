/**
 * Frontend Type Definitions
 *
 * Defines TypeScript interfaces for API responses and frontend state.
 * These types mirror the backend API response formats.
 */

/**
 * URL response from the API.
 * Represents a shortened URL with its metadata.
 */
export interface Url {
  short_url: string;
  short_code: string;
  long_url: string;
  created_at: string;
  expires_at: string | null;
  click_count: number;
  is_custom: boolean;
}

/**
 * Input data for creating a new shortened URL.
 */
export interface CreateUrlInput {
  long_url: string;
  custom_code?: string;
  expires_in?: number;
}

/**
 * Aggregated analytics data for a URL.
 */
export interface UrlAnalytics {
  short_code: string;
  total_clicks: number;
  clicks_by_day: { date: string; count: number }[];
  top_referrers: { referrer: string; count: number }[];
  devices: { device: string; count: number }[];
}

/**
 * User data from the API.
 */
export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  created_at: string;
}

/**
 * Login form input data.
 */
export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Registration form input data.
 */
export interface RegisterInput {
  email: string;
  password: string;
}

/**
 * System-wide statistics for admin dashboard.
 */
export interface SystemStats {
  total_urls: number;
  total_clicks: number;
  active_urls: number;
  keys_available: number;
  keys_used: number;
  urls_created_today: number;
  clicks_today: number;
  top_urls: { short_code: string; long_url: string; click_count: number }[];
}

/**
 * Platform-wide analytics for admin dashboard.
 */
export interface GlobalAnalytics {
  totalClicks: number;
  clicksToday: number;
  clicksByHour: { hour: number; count: number }[];
  topUrls: { short_code: string; count: number }[];
}

/**
 * Generic paginated response wrapper.
 */
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

/**
 * Paginated URL list response.
 */
export interface UrlsResponse {
  urls: Url[];
  total: number;
}

/**
 * Paginated user list response.
 */
export interface UsersResponse {
  users: User[];
  total: number;
}

/**
 * Key pool statistics for admin dashboard.
 */
export interface KeyPoolStats {
  total: number;
  used: number;
  available: number;
  allocated: number;
}
