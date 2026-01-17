// URL types
export interface Url {
  short_url: string;
  short_code: string;
  long_url: string;
  created_at: string;
  expires_at: string | null;
  click_count: number;
  is_custom: boolean;
}

export interface CreateUrlInput {
  long_url: string;
  custom_code?: string;
  expires_in?: number;
}

// Analytics types
export interface UrlAnalytics {
  short_code: string;
  total_clicks: number;
  clicks_by_day: { date: string; count: number }[];
  top_referrers: { referrer: string; count: number }[];
  devices: { device: string; count: number }[];
}

// User types
export interface User {
  id: string;
  email: string;
  role: 'user' | 'admin';
  created_at: string;
}

// Auth types
export interface LoginInput {
  email: string;
  password: string;
}

export interface RegisterInput {
  email: string;
  password: string;
}

// System stats types
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

// Global analytics types
export interface GlobalAnalytics {
  totalClicks: number;
  clicksToday: number;
  clicksByHour: { hour: number; count: number }[];
  topUrls: { short_code: string; count: number }[];
}

// API response types
export interface PaginatedResponse<T> {
  items: T[];
  total: number;
}

export interface UrlsResponse {
  urls: Url[];
  total: number;
}

export interface UsersResponse {
  users: User[];
  total: number;
}

export interface KeyPoolStats {
  total: number;
  used: number;
  available: number;
  allocated: number;
}
