/**
 * URL database model representing a shortened URL record.
 * Stores the mapping between short codes and destination URLs along with metadata.
 */
export interface Url {
  short_code: string;
  long_url: string;
  user_id: string | null;
  created_at: Date;
  expires_at: Date | null;
  click_count: number;
  is_active: boolean;
  is_custom: boolean;
}

/**
 * Input data for creating a new shortened URL.
 */
export interface CreateUrlInput {
  long_url: string;
  custom_code?: string;
  expires_in?: number; // seconds
  user_id?: string;
}

/**
 * API response format for a URL, including the full short URL.
 */
export interface UrlResponse {
  short_url: string;
  short_code: string;
  long_url: string;
  created_at: string;
  expires_at: string | null;
  click_count: number;
  is_custom: boolean;
}

/**
 * Click event database model tracking individual URL visits.
 * Used for analytics and traffic analysis.
 */
export interface ClickEvent {
  id: number;
  short_code: string;
  clicked_at: Date;
  referrer: string | null;
  user_agent: string | null;
  ip_address: string | null;
  country: string | null;
  city: string | null;
  device_type: string | null;
}

/**
 * Input data for recording a click event.
 */
export interface ClickEventInput {
  short_code: string;
  referrer?: string;
  user_agent?: string;
  ip_address?: string;
}

/**
 * Aggregated analytics data for a single URL.
 * Includes click trends, referrer sources, and device breakdowns.
 */
export interface UrlAnalytics {
  short_code: string;
  total_clicks: number;
  clicks_by_day: { date: string; count: number }[];
  top_referrers: { referrer: string; count: number }[];
  devices: { device: string; count: number }[];
}

/**
 * Key pool entry representing a pre-generated short code.
 * Keys are allocated to server instances to avoid collisions in distributed deployments.
 */
export interface KeyPoolEntry {
  short_code: string;
  is_used: boolean;
  allocated_to: string | null;
  allocated_at: Date | null;
}

/**
 * User database model with authentication credentials.
 */
export interface User {
  id: string;
  email: string;
  password_hash: string;
  role: 'user' | 'admin';
  created_at: Date;
  is_active: boolean;
}

/**
 * Public user data safe to expose in API responses (no password hash).
 */
export interface UserPublic {
  id: string;
  email: string;
  role: 'user' | 'admin';
  created_at: string;
}

/**
 * Input data for user registration.
 */
export interface CreateUserInput {
  email: string;
  password: string;
  role?: 'user' | 'admin';
}

/**
 * Input data for user login.
 */
export interface LoginInput {
  email: string;
  password: string;
}

/**
 * Session database model for user authentication.
 */
export interface Session {
  id: string;
  user_id: string;
  token: string;
  created_at: Date;
  expires_at: Date;
}

/**
 * System-wide statistics for the admin dashboard.
 * Aggregates URL, click, and key pool metrics.
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
